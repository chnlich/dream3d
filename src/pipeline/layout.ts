import type { LayoutFn } from "./types";
import type { SceneObject } from "../scene/schema";
import { footprintPenetration } from "../scene/bbox";

// Deterministic layout pass: ScenePlan -> initial SceneState (pass 0).
//
// Conventions (see scene/schema.ts): `transform.position` is the object CENTER in
// world space, the floor is y=0, and the viewer normalizes each GLB so that at
// `scale = 1` its bounding box ≈ `approxSize`. So we keep scale at 1 and only
// decide placement here: keep the planned X/Z, drop the object onto the floor
// (center y = half its height), then nudge apart any objects whose footprints
// overlap. Pure + deterministic — same plan in, same scene out.

const MAX_NUDGE_ITERATIONS = 24;

export const layout: LayoutFn = (plan) => {
  const objects: SceneObject[] = plan.objects.map((obj) => ({
    id: obj.id,
    label: obj.label,
    meshyPrompt: obj.meshyPrompt,
    approxSize: obj.approxSize,
    transform: {
      position: [obj.position[0], obj.approxSize[1] / 2, obj.position[2]],
      rotationYDeg: obj.rotationYDeg,
      scale: 1,
    },
    status: "pending",
  }));

  separateOverlaps(objects);

  return { room: plan.room, objects, pass: 0 };
};

// Iteratively push overlapping footprints apart along the horizontal axis of
// least penetration. Both objects share the correction so neither drifts far;
// y is never touched, keeping everything on the floor.
function separateOverlaps(objects: SceneObject[]): void {
  for (let iteration = 0; iteration < MAX_NUDGE_ITERATIONS; iteration++) {
    let moved = false;
    for (let i = 0; i < objects.length; i++) {
      for (let j = i + 1; j < objects.length; j++) {
        if (pushApart(objects[i], objects[j])) {
          moved = true;
        }
      }
    }
    if (!moved) {
      break;
    }
  }
}

function pushApart(a: SceneObject, b: SceneObject): boolean {
  const { x: penetrationX, z: penetrationZ } = footprintPenetration(a, b);
  if (penetrationX <= 0 || penetrationZ <= 0) {
    return false; // already clear on at least one horizontal axis
  }

  const [ax, , az] = a.transform.position;
  const [bx, , bz] = b.transform.position;
  if (penetrationX <= penetrationZ) {
    const dir = ax === bx ? -1 : Math.sign(ax - bx); // tie-break: a goes -X, b goes +X
    const shift = (penetrationX / 2) * dir;
    a.transform.position[0] += shift;
    b.transform.position[0] -= shift;
  } else {
    const dir = az === bz ? -1 : Math.sign(az - bz);
    const shift = (penetrationZ / 2) * dir;
    a.transform.position[2] += shift;
    b.transform.position[2] -= shift;
  }
  return true;
}
