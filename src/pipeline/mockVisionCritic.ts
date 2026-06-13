import type { VisionCritic } from "./types";
import type { ReviewIssue, SceneState } from "../scene/schema";

// Deterministic stand-in for the Claude-vision critic. Filled by a later chunk.
export const mockVisionCritic: VisionCritic = {
  async review(_input: { scene: SceneState; screenshotDataUrl: string }): Promise<ReviewIssue[]> {
    throw new Error("not implemented — filled by a later chunk");
  },
};
