import type { VisionCritic } from "./types";
import type { ReviewIssue, SceneState } from "../scene/schema";

// Real vision critic backed by Claude vision (@anthropic-ai/sdk). Implemented by a later chunk.
export const claudeVisionCritic: VisionCritic = {
  async review(_input: { scene: SceneState; screenshotDataUrl: string }): Promise<ReviewIssue[]> {
    throw new Error("not implemented — filled by a later chunk");
  },
};
