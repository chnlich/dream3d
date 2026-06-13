import type { Planner } from "./types";
import type { PlannedObject, ScenePlan, Vec3 } from "../scene/schema";

// Offline, deterministic stand-in for the Claude-backed planner. Scans the
// prompt for known furniture nouns, turns each match into a PlannedObject with a
// plausible real-world size, and lays them out spread across a room sized to the
// object count. Always yields 3–5 objects (pads with sensible defaults when the
// prompt is sparse, caps at 5). No network, instant.

interface CatalogEntry {
  id: string;
  label: string;
  meshyPrompt: string;
  approxSize: Vec3; // width (X) / height (Y) / depth (Z), meters
  keywords: string[];
}

const CATALOG: CatalogEntry[] = [
  { id: "sofa", label: "Sofa", meshyPrompt: "a modern three-seat fabric sofa", approxSize: [2.0, 0.85, 0.9], keywords: ["sofa", "couch"] },
  { id: "armchair", label: "Armchair", meshyPrompt: "a single upholstered armchair", approxSize: [0.75, 1.0, 0.75], keywords: ["armchair", "chair"] },
  { id: "table", label: "Coffee Table", meshyPrompt: "a low rectangular wooden coffee table", approxSize: [1.1, 0.45, 0.6], keywords: ["table", "coffee table"] },
  { id: "desk", label: "Desk", meshyPrompt: "a wooden writing desk", approxSize: [1.4, 0.75, 0.7], keywords: ["desk"] },
  { id: "bed", label: "Bed", meshyPrompt: "a queen-size platform bed", approxSize: [2.0, 0.6, 1.6], keywords: ["bed"] },
  { id: "lamp", label: "Floor Lamp", meshyPrompt: "a tall modern floor lamp", approxSize: [0.4, 1.6, 0.4], keywords: ["lamp"] },
  { id: "bookshelf", label: "Bookshelf", meshyPrompt: "a tall wooden bookshelf", approxSize: [1.0, 1.8, 0.35], keywords: ["bookshelf", "bookcase", "shelf"] },
  { id: "plant", label: "Potted Plant", meshyPrompt: "a potted indoor plant", approxSize: [0.6, 1.4, 0.6], keywords: ["plant", "tree", "fern"] },
  { id: "rug", label: "Area Rug", meshyPrompt: "a rectangular woven area rug", approxSize: [2.4, 0.04, 1.7], keywords: ["rug", "carpet"] },
  { id: "tv", label: "Television", meshyPrompt: "a flat-screen television", approxSize: [1.3, 0.75, 0.12], keywords: ["tv", "television"] },
  { id: "cabinet", label: "Cabinet", meshyPrompt: "a wooden storage cabinet", approxSize: [1.1, 1.0, 0.5], keywords: ["cabinet", "dresser"] },
  { id: "stool", label: "Stool", meshyPrompt: "a round wooden stool", approxSize: [0.4, 0.5, 0.4], keywords: ["stool"] },
  { id: "nightstand", label: "Nightstand", meshyPrompt: "a small bedside nightstand", approxSize: [0.5, 0.55, 0.4], keywords: ["nightstand"] },
  { id: "wardrobe", label: "Wardrobe", meshyPrompt: "a tall wardrobe closet", approxSize: [1.6, 2.0, 0.6], keywords: ["wardrobe", "closet"] },
];

// Used to pad sparse prompts up to the 3-object minimum.
const FALLBACK_IDS = ["rug", "plant", "lamp"];

const MIN_OBJECTS = 3;
const MAX_OBJECTS = 5;

export const mockPlanner: Planner = {
  async plan(prompt: string): Promise<ScenePlan> {
    const entries = selectEntries(prompt);
    const room = roomFor(entries.length);
    const objects = entries.map((entry, index) => placeObject(entry, index, entries.length, room));
    return { prompt, room, objects };
  },
};

function selectEntries(prompt: string): CatalogEntry[] {
  const lower = prompt.toLowerCase();
  const matched = CATALOG.filter((entry) => entry.keywords.some((kw) => matchesWord(lower, kw)));

  const selected = matched.slice(0, MAX_OBJECTS);
  for (const id of FALLBACK_IDS) {
    if (selected.length >= MIN_OBJECTS) {
      break;
    }
    if (!selected.some((entry) => entry.id === id)) {
      selected.push(byId(id));
    }
  }
  return selected;
}

function matchesWord(haystack: string, keyword: string): boolean {
  return new RegExp(`\\b${keyword}\\b`).test(haystack);
}

function byId(id: string): CatalogEntry {
  const entry = CATALOG.find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error(`mockPlanner: no catalog entry for fallback id "${id}"`);
  }
  return entry;
}

function roomFor(count: number): { width: number; depth: number; height: number } {
  return {
    width: Math.max(6, count * 1.8),
    depth: Math.max(5, count * 1.3),
    height: 3,
  };
}

// Spread objects evenly along X and alternate them in Z so footprints rarely
// collide before layout runs. y is left at 0 — layout drops each to the floor.
function placeObject(
  entry: CatalogEntry,
  index: number,
  count: number,
  room: { width: number; depth: number },
): PlannedObject {
  const spacing = room.width / (count + 1);
  const x = -room.width / 2 + spacing * (index + 1);
  const z = (index % 2 === 0 ? -1 : 1) * room.depth * 0.2;
  return {
    id: entry.id,
    label: entry.label,
    meshyPrompt: entry.meshyPrompt,
    approxSize: entry.approxSize,
    position: [x, 0, z],
    rotationYDeg: 0,
  };
}
