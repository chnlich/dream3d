import type { LayoutFn } from "./types";

// Deterministic layout pass: ScenePlan -> initial SceneState. Implemented by a later chunk.
export const layout: LayoutFn = (_plan) => {
  throw new Error("not implemented — filled by a later chunk");
};
