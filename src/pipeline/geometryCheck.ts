import type { GeomCheckFn } from "./types";
import type { ReviewIssue, SceneObject, Vec3 } from "../scene/schema";

// Pure-geometry review pass: flags objects that float off the floor, poke
// outside the room, or overlap another object's footprint. Every issue carries
// a deterministic `move` Fix that, when applied, resolves it. Same conventions
// as layout.ts: position is the object CENTER, floor at y=0, room centered on
// the origin (x in [-w/2, w/2], z in [-d/2, d/2], y in [0, height]).

const FLOOR_TOLERANCE = 0.05; // meters a center may deviate from its resting height
const SEPARATION_GAP = 0.05; // matches layout.ts so a laid-out scene reports clean

export const geometryCheck: GeomCheckFn = (scene) => {
  const issues: ReviewIssue[] = [];
  const halfWidth = scene.room.width / 2;
  const halfDepth = scene.room.depth / 2;

  for (const obj of scene.objects) {
    const half = halfExtents(obj);
    const [x, y, z] = obj.transform.position;

    const restY = half[1]; // center height when sitting on the floor
    if (Math.abs(y - restY) > FLOOR_TOLERANCE) {
      issues.push({
        objectId: obj.id,
        kind: "floating",
        severity: "medium",
        description: `${obj.label} sits ${(y - restY).toFixed(2)}m off the floor`,
        fix: { op: "move", delta: [0, restY - y, 0] },
        source: "geometry",
      });
    }

    const overflowX = axisOverflow(x, half[0], halfWidth);
    const overflowZ = axisOverflow(z, half[2], halfDepth);
    const overflowCeiling = Math.max(0, y + half[1] - scene.room.height);
    if (overflowX !== 0 || overflowZ !== 0 || overflowCeiling > 0) {
      issues.push({
        objectId: obj.id,
        kind: "out_of_bounds",
        severity: "high",
        description: `${obj.label} extends outside the room`,
        fix: { op: "move", delta: [-overflowX, -overflowCeiling, -overflowZ] },
        source: "geometry",
      });
    }
  }

  for (let i = 0; i < scene.objects.length; i++) {
    for (let j = i + 1; j < scene.objects.length; j++) {
      const issue = overlapIssue(scene.objects[i], scene.objects[j]);
      if (issue) {
        issues.push(issue);
      }
    }
  }

  return issues;
};

function halfExtents(obj: SceneObject): Vec3 {
  const s = obj.transform.scale;
  return [(obj.approxSize[0] * s) / 2, (obj.approxSize[1] * s) / 2, (obj.approxSize[2] * s) / 2];
}

// Signed amount the [center-half, center+half] span pokes past [-bound, bound].
// Positive => exceeds +bound, negative => exceeds -bound, 0 => inside.
function axisOverflow(center: number, half: number, bound: number): number {
  const max = center + half;
  const min = center - half;
  if (max > bound) {
    return max - bound;
  }
  if (min < -bound) {
    return min + bound;
  }
  return 0;
}

// If a's and b's footprints overlap, return an issue that moves b clear of a
// along the horizontal axis of least penetration.
function overlapIssue(a: SceneObject, b: SceneObject): ReviewIssue | null {
  const ah = halfExtents(a);
  const bh = halfExtents(b);
  const [ax, , az] = a.transform.position;
  const [bx, , bz] = b.transform.position;

  const penetrationX = ah[0] + bh[0] + SEPARATION_GAP - Math.abs(ax - bx);
  const penetrationZ = ah[2] + bh[2] + SEPARATION_GAP - Math.abs(az - bz);
  if (penetrationX <= 0 || penetrationZ <= 0) {
    return null;
  }

  let delta: Vec3;
  if (penetrationX <= penetrationZ) {
    const dir = bx === ax ? 1 : Math.sign(bx - ax);
    delta = [penetrationX * dir, 0, 0];
  } else {
    const dir = bz === az ? 1 : Math.sign(bz - az);
    delta = [0, 0, penetrationZ * dir];
  }

  return {
    objectId: b.id,
    kind: "overlap",
    severity: "medium",
    description: `${b.label} overlaps ${a.label}`,
    fix: { op: "move", delta },
    source: "geometry",
  };
}
