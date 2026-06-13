import type { Planner } from "./types";
import type { ScenePlan } from "../scene/schema";

// Real planner backed by Claude (@anthropic-ai/sdk). Implemented by a later chunk.
export const claudePlanner: Planner = {
  async plan(_prompt: string): Promise<ScenePlan> {
    throw new Error("not implemented — filled by a later chunk");
  },
};
