import Anthropic from "@anthropic-ai/sdk";
import type { Planner } from "./types";
import type { PlannedObject, Room, ScenePlan, Vec3 } from "../scene/schema";
import { loadConfig } from "../config";

// Real planner backed by Claude (@anthropic-ai/sdk). Opus 4.8 is asked to emit the
// plan through a forced tool call (structured output), which we validate into a
// typed ScenePlan. Anything off-shape throws — no silent fallback.
const MODEL = "claude-opus-4-8";
const MAX_TOKENS = 4096;
const MIN_OBJECTS = 3;
const MAX_OBJECTS = 6;

const SYSTEM_PROMPT = [
  "You are a 3D interior scene planner.",
  "Given a short scene description, design one plausible room and the objects inside it,",
  "then return them by calling the emit_scene_plan tool exactly once.",
  "",
  "Rules:",
  `- Include between ${MIN_OBJECTS} and ${MAX_OBJECTS} distinct objects — the main furniture/props the description implies.`,
  "- Each meshyPrompt describes ONE isolated object for text-to-3D generation: give its",
  "  silhouette, material, and archetype. No brand names or trademarked/IP characters, no",
  "  background or setting, no other objects, no people — just the single object itself.",
  "- approxSize is the object's bounding box [x, y, z] in meters; use realistic dimensions.",
  "- The room origin is its center, on the floor. Floor is y = 0 and Y points up.",
  "- position is each object's CENTER in world meters: keep it inside the room",
  "  (x within ±width/2, z within ±depth/2) and rest it on the floor (y ≈ approxSize[1] / 2,",
  "  or the appropriate mounting height). Do not overlap objects.",
  "- rotationYDeg is the yaw in degrees; 0 faces +Z. Orient objects sensibly.",
].join("\n");

const VEC3_SCHEMA = { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 } as const;

const SCENE_PLAN_TOOL: Anthropic.Tool = {
  name: "emit_scene_plan",
  description: "Return the structured room + objects layout for the requested scene.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["room", "objects"],
    properties: {
      room: {
        type: "object",
        additionalProperties: false,
        required: ["width", "depth", "height"],
        properties: {
          width: { type: "number", description: "interior size along X, meters" },
          depth: { type: "number", description: "interior size along Z, meters" },
          height: { type: "number", description: "ceiling height along Y, meters" },
        },
      },
      objects: {
        type: "array",
        minItems: MIN_OBJECTS,
        maxItems: MAX_OBJECTS,
        description: `${MIN_OBJECTS} to ${MAX_OBJECTS} objects placed in the room`,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "label", "meshyPrompt", "approxSize", "position", "rotationYDeg"],
          properties: {
            id: { type: "string", description: "unique kebab-case id, e.g. 'sofa-1'" },
            label: { type: "string", description: "short human label, e.g. 'Sofa'" },
            meshyPrompt: {
              type: "string",
              description:
                "Single isolated object for text-to-3D: silhouette + material + archetype. " +
                "No IP/brand names, no background, no other objects.",
            },
            approxSize: { ...VEC3_SCHEMA, description: "intended bounding box [x, y, z] in meters" },
            position: { ...VEC3_SCHEMA, description: "object center [x, y, z] in world meters (floor at y=0)" },
            rotationYDeg: { type: "number", description: "yaw in degrees; 0 faces +Z" },
          },
        },
      },
    },
  },
};

export const claudePlanner: Planner = {
  async plan(prompt: string): Promise<ScenePlan> {
    const trimmed = prompt.trim();
    if (trimmed.length === 0) {
      throw new Error("claudePlanner.plan: prompt must be a non-empty string");
    }

    const { anthropicApiKey } = loadConfig();
    const client = new Anthropic({ apiKey: anthropicApiKey });

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: [SCENE_PLAN_TOOL],
      tool_choice: { type: "tool", name: SCENE_PLAN_TOOL.name },
      messages: [{ role: "user", content: trimmed }],
    });

    const toolUse = response.content.find((block) => block.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error(
        `claudePlanner: model did not return a tool_use block (stop_reason=${response.stop_reason})`,
      );
    }

    const input = asRecord(toolUse.input, "scene plan");
    const roomRaw = asRecord(input.room, "room");
    const room: Room = {
      width: asNumber(roomRaw.width, "room.width"),
      depth: asNumber(roomRaw.depth, "room.depth"),
      height: asNumber(roomRaw.height, "room.height"),
    };

    if (!Array.isArray(input.objects)) {
      throw new Error(`claudePlanner: expected objects[] array, got ${describe(input.objects)}`);
    }
    if (input.objects.length < MIN_OBJECTS || input.objects.length > MAX_OBJECTS) {
      throw new Error(
        `claudePlanner: expected ${MIN_OBJECTS}-${MAX_OBJECTS} objects, got ${input.objects.length}`,
      );
    }

    const seenIds = new Set<string>();
    const objects: PlannedObject[] = input.objects.map((raw, i) => {
      const o = asRecord(raw, `objects[${i}]`);
      const id = asNonEmptyString(o.id, `objects[${i}].id`);
      if (seenIds.has(id)) {
        throw new Error(`claudePlanner: duplicate object id "${id}"`);
      }
      seenIds.add(id);
      return {
        id,
        label: asNonEmptyString(o.label, `objects[${i}].label`),
        meshyPrompt: asNonEmptyString(o.meshyPrompt, `objects[${i}].meshyPrompt`),
        approxSize: asVec3(o.approxSize, `objects[${i}].approxSize`),
        position: asVec3(o.position, `objects[${i}].position`),
        rotationYDeg: asNumber(o.rotationYDeg, `objects[${i}].rotationYDeg`),
      };
    });

    return { prompt, room, objects };
  },
};

// --- validation helpers: the model's tool input is untrusted, so narrow loudly ---

function asRecord(value: unknown, ctx: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`claudePlanner: expected an object at ${ctx}, got ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

function asNumber(value: unknown, ctx: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`claudePlanner: expected a finite number at ${ctx}, got ${describe(value)}`);
  }
  return value;
}

function asNonEmptyString(value: unknown, ctx: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`claudePlanner: expected a non-empty string at ${ctx}, got ${describe(value)}`);
  }
  return value;
}

function asVec3(value: unknown, ctx: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`claudePlanner: expected a [x, y, z] array at ${ctx}, got ${describe(value)}`);
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
