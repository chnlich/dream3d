import type { Planner } from "./types";
import type { ScenePlan } from "../scene/schema";

// Deterministic stand-in for the Claude-backed planner. Filled by a later chunk.
export const mockPlanner: Planner = {
  async plan(_prompt: string): Promise<ScenePlan> {
    throw new Error("not implemented — filled by a later chunk");
  },
};
