import type { SceneObject, Vec3 } from "./schema";

// Shared axis-aligned bounding-box geometry for the layout and geometry-check
// passes. Both share ONE notion of an object's footprint and the minimum
// clearance between footprints; only the way each pass RESOLVES an overlap
// differs (layout splits the push between both objects; geometryCheck emits a
// one-sided move of b), so just the shared computation lives here.

// Meters of clearance to leave between two footprints. layout uses it to nudge
// objects apart; geometryCheck uses it so a laid-out scene reports clean.
export const SEPARATION_GAP = 0.05;

// Half-extents of an object's axis-aligned bounding box (approxSize * scale / 2).
export function halfExtents(obj: SceneObject): Vec3 {
  const s = obj.transform.scale;
  return [(obj.approxSize[0] * s) / 2, (obj.approxSize[1] * s) / 2, (obj.approxSize[2] * s) / 2];
}

// Footprint penetration of a and b on each horizontal axis: how far their
// bounding boxes (each grown by SEPARATION_GAP) overlap on X and on Z. A
// positive value on BOTH axes means the footprints overlap; a value <= 0 on
// either axis means they are already clear on that axis. Callers decide how to
// resolve a positive overlap.
export function footprintPenetration(a: SceneObject, b: SceneObject): { x: number; z: number } {
  const ah = halfExtents(a);
  const bh = halfExtents(b);
  const [ax, , az] = a.transform.position;
  const [bx, , bz] = b.transform.position;
  return {
    x: ah[0] + bh[0] + SEPARATION_GAP - Math.abs(ax - bx),
    z: ah[2] + bh[2] + SEPARATION_GAP - Math.abs(az - bz),
  };
}
