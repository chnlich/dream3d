import type { ApplyFixFn } from "./types";

// Applies review fixes to a scene, producing the next-pass SceneState. Implemented by a later chunk.
export const fix: ApplyFixFn = (_scene, _issues) => {
  throw new Error("not implemented — filled by a later chunk");
};
