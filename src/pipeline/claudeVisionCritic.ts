import Anthropic from "@anthropic-ai/sdk";
import type { VisionCritic } from "./types";
import type { Fix, IssueKind, ReviewIssue, SceneState, Severity, Vec3 } from "../scene/schema";
import { loadConfig } from "../config";

// Real vision critic backed by Claude vision (@anthropic-ai/sdk). Opus 4.8 sees the
// rendered screenshot plus the layout JSON and reports placement problems through a
// forced tool call, which we validate into typed ReviewIssue[] tagged source:"vision".
const MODEL = "claude-opus-4-8";
const MAX_TOKENS = 4096;

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

const SYSTEM_PROMPT = [
  "You are a meticulous reviewer of rendered 3D interior scenes.",
  "You receive a screenshot of the current layout and the layout JSON (each object's id,",
  "label, size, and transform). Compare the image against the layout and report concrete,",
  "visible placement problems by calling the emit_review_issues tool exactly once.",
  "",
  "Each issue must reference an existing object id and carry exactly one concrete fix:",
  "- overlap / out_of_bounds / floating  -> op 'move', delta [dx, dy, dz] in meters.",
  "- wrong_facing                        -> op 'rotate', rotationYDeg degrees to add.",
  "- too_big / too_small                 -> op 'resize', scaleFactor (>1 enlarges, <1 shrinks).",
  "Report only real problems you can see. If the scene looks correct, return an empty list.",
].join("\n");

const VEC3_SCHEMA = { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 } as const;

const REVIEW_TOOL: Anthropic.Tool = {
  name: "emit_review_issues",
  description: "Return the placement problems found in the rendered scene (empty if none).",
  input_schema: {
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
  },
};

export const claudeVisionCritic: VisionCritic = {
  async review(input: { scene: SceneState; screenshotDataUrl: string }): Promise<ReviewIssue[]> {
    const { scene, screenshotDataUrl } = input;
    const image = parseScreenshot(screenshotDataUrl);
    const knownIds = new Set(scene.objects.map((o) => o.id));

    const { anthropicApiKey } = loadConfig();
    const client = new Anthropic({ apiKey: anthropicApiKey });

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: [REVIEW_TOOL],
      tool_choice: { type: "tool", name: REVIEW_TOOL.name },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
            { type: "text", text: `Layout JSON:\n${layoutSummary(scene)}` },
          ],
        },
      ],
    });

    const toolUse = response.content.find((block) => block.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error(
        `claudeVisionCritic: model did not return a tool_use block (stop_reason=${response.stop_reason})`,
      );
    }

    const result = asRecord(toolUse.input, "review result");
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

// --- validation helpers: the model's tool input is untrusted, so narrow loudly ---

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
