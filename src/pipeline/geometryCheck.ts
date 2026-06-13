import type { GeomCheckFn } from "./types";

// Pure-geometry review pass: flags overlap / floating / out_of_bounds. Implemented by a later chunk.
export const geometryCheck: GeomCheckFn = (_scene) => {
  throw new Error("not implemented — filled by a later chunk");
};
