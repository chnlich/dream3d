import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VisionCritic } from "./types";
import type { Fix, IssueKind, ReviewIssue, SceneState, Severity, Vec3 } from "../scene/schema";
import { runClaude } from "../llm/claudeCli";

// Real vision critic backed by the headless local `claude` CLI. Opus 4.8 reads the
// rendered screenshot (passed as a file path via the Read tool) plus the layout JSON
// and reports placement problems as a JSON object, which we validate into typed
// ReviewIssue[] tagged source:"vision". (Not exercised at amendRounds=0.)

// The kinds a vision pass can detect (geometry handles the rest); each maps to one fix op.
const ISSUE_KINDS: IssueKind[] = [
  "overlap",
  "floating",
  "wrong_facing",
  "too_big",
  "too_small",
  "out_of_bounds",
];
const SEVERITIES: Severity[] = ["low", "medium", "high"];
const FIX_OPS = ["move", "rotate", "resize"] as const;
type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
const EXT_BY_MEDIA: Record<ImageMediaType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

const SYSTEM_PROMPT = [
  "You are a meticulous reviewer of rendered 3D interior scenes.",
  "You receive a screenshot of the current layout and the layout JSON (each object's id,",
  "label, size, and transform). Compare the image against the layout and report concrete,",
  "visible placement problems as a single JSON object matching the schema below.",
  "",
  "Each issue must reference an existing object id and carry exactly one concrete fix:",
  "- overlap / out_of_bounds / floating  -> op 'move', delta [dx, dy, dz] in meters.",
  "- wrong_facing                        -> op 'rotate', rotationYDeg degrees to add.",
  "- too_big / too_small                 -> op 'resize', scaleFactor (>1 enlarges, <1 shrinks).",
  "Report only real problems you can see. If the scene looks correct, return an empty list.",
].join("\n");

const VEC3_SCHEMA = { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 } as const;

// The shape the model must return (formerly the emit_review_issues tool's input_schema),
// delivered in the prompt text since the headless CLI exposes no tool-calling.
const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["issues"],
  properties: {
    issues: {
      type: "array",
      description: "zero or more concrete issues; empty when the scene looks correct",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["objectId", "kind", "severity", "description", "fix"],
        properties: {
          objectId: { type: "string", description: "id of the offending object; must exist in the layout" },
          kind: { type: "string", enum: ISSUE_KINDS },
          severity: { type: "string", enum: SEVERITIES },
          description: { type: "string", description: "one concrete sentence describing the visible problem" },
          fix: {
            type: "object",
            additionalProperties: false,
            required: ["op"],
            properties: {
              op: { type: "string", enum: FIX_OPS },
              delta: { ...VEC3_SCHEMA, description: "move op: meters added to position [dx, dy, dz]" },
              rotationYDeg: { type: "number", description: "rotate op: degrees added to current yaw" },
              scaleFactor: { type: "number", description: "resize op: multiplier on current scale (>1 bigger)" },
            },
          },
        },
      },
    },
  },
};

export const claudeVisionCritic: VisionCritic = {
  async review(input: { scene: SceneState; screenshotDataUrl: string }): Promise<ReviewIssue[]> {
    const { scene, screenshotDataUrl } = input;
    const image = parseScreenshot(screenshotDataUrl);
    const knownIds = new Set(scene.objects.map((o) => o.id));

    // runClaude reads images off disk, so spill the screenshot to a temp file and pass
    // its absolute path. Clean up the temp dir regardless of outcome.
    const dir = mkdtempSync(join(tmpdir(), "dream3d-critic-"));
    const imagePath = join(dir, `screenshot.${EXT_BY_MEDIA[image.mediaType]}`);
    writeFileSync(imagePath, Buffer.from(image.data, "base64"));

    let text: string;
    try {
      const prompt = [
        SYSTEM_PROMPT,
        "",
        `Layout JSON:\n${layoutSummary(scene)}`,
        "",
        "Respond with ONLY the JSON object — no prose, no markdown code fences. It must match this schema:",
        JSON.stringify(REVIEW_SCHEMA, null, 2),
      ].join("\n");
      text = await runClaude(prompt, { imagePaths: [imagePath] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const result = asRecord(parseJson(text), "review result");
    if (!Array.isArray(result.issues)) {
      throw new Error(`claudeVisionCritic: expected issues[] array, got ${describe(result.issues)}`);
    }

    return result.issues.map((raw, i) => {
      const issue = asRecord(raw, `issues[${i}]`);
      const objectId = asNonEmptyString(issue.objectId, `issues[${i}].objectId`);
      if (!knownIds.has(objectId)) {
        throw new Error(`claudeVisionCritic: issues[${i}].objectId "${objectId}" is not in the scene`);
      }
      return {
        objectId,
        kind: asEnum(issue.kind, ISSUE_KINDS, `issues[${i}].kind`),
        severity: asEnum(issue.severity, SEVERITIES, `issues[${i}].severity`),
        description: asNonEmptyString(issue.description, `issues[${i}].description`),
        fix: parseFix(issue.fix, `issues[${i}].fix`),
        source: "vision",
      };
    });
  },
};

// Compact, model-facing view of the scene so the critic can map pixels to object ids.
function layoutSummary(scene: SceneState): string {
  return JSON.stringify(
    {
      room: scene.room,
      pass: scene.pass,
      objects: scene.objects.map((o) => ({
        id: o.id,
        label: o.label,
        approxSize: o.approxSize,
        position: o.transform.position,
        rotationYDeg: o.transform.rotationYDeg,
        scale: o.transform.scale,
        status: o.status,
      })),
    },
    null,
    2,
  );
}

function parseScreenshot(dataUrl: string): { mediaType: ImageMediaType; data: string } {
  const match = /^data:(image\/(?:png|jpe?g|gif|webp));base64,(.+)$/s.exec(dataUrl.trim());
  if (!match) {
    throw new Error("claudeVisionCritic: screenshotDataUrl must be a base64-encoded image data URL");
  }
  const declared = match[1];
  const mediaType: ImageMediaType = declared === "image/jpg" ? "image/jpeg" : (declared as ImageMediaType);
  return { mediaType, data: match[2] };
}

// --- response parsing + validation: the model's output is untrusted, so narrow loudly ---

// The CLI returns the model's final text; it may wrap the JSON in a ```json fence.
// Strip a fenced block if present, then parse — failing loudly on anything unparseable.
function parseJson(text: string): unknown {
  let body = text.trim();
  const fence = /```(?:json)?\s*\n?([\s\S]*?)```/.exec(body);
  if (fence) {
    body = fence[1].trim();
  }
  try {
    return JSON.parse(body);
  } catch (cause) {
    throw new Error(`claudeVisionCritic: model output was not valid JSON: ${body.slice(0, 1000)}`, { cause });
  }
}

function parseFix(value: unknown, ctx: string): Fix {
  const raw = asRecord(value, ctx);
  const op = asEnum(raw.op, FIX_OPS, `${ctx}.op`);
  if (op === "move") return { op, delta: asVec3(raw.delta, `${ctx}.delta`) };
  if (op === "rotate") return { op, rotationYDeg: asNumber(raw.rotationYDeg, `${ctx}.rotationYDeg`) };
  return { op, scaleFactor: asNumber(raw.scaleFactor, `${ctx}.scaleFactor`) };
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], ctx: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(
      `claudeVisionCritic: expected one of [${allowed.join(", ")}] at ${ctx}, got ${describe(value)}`,
    );
  }
  return value as T;
}

function asRecord(value: unknown, ctx: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`claudeVisionCritic: expected an object at ${ctx}, got ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

function asNumber(value: unknown, ctx: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`claudeVisionCritic: expected a finite number at ${ctx}, got ${describe(value)}`);
  }
  return value;
}

function asNonEmptyString(value: unknown, ctx: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`claudeVisionCritic: expected a non-empty string at ${ctx}, got ${describe(value)}`);
  }
  return value;
}

function asVec3(value: unknown, ctx: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`claudeVisionCritic: expected a [x, y, z] array at ${ctx}, got ${describe(value)}`);
  }
  return [
    asNumber(value[0], `${ctx}[0]`),
    asNumber(value[1], `${ctx}[1]`),
    asNumber(value[2], `${ctx}[2]`),
  ];
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(len ${value.length})`;
  return typeof value;
}
