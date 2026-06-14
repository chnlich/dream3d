import type { ApplyFixFn } from "./types";
import type { ReviewIssue, SceneObject } from "../scene/schema";

// Applies review fixes to a scene, producing the next-pass SceneState. Works on
// a deep clone so the caller's scene is never mutated, then bumps `pass`. Each
// issue's Fix is applied in order; later fixes simply compound on earlier ones.
export const fix: ApplyFixFn = (scene, issues) => {
  const next = structuredClone(scene);
  for (const issue of issues) {
    const obj = next.objects.find((candidate) => candidate.id === issue.objectId);
    if (!obj) {
      throw new Error(`fix: issue targets unknown object "${issue.objectId}"`);
    }
    applyFix(obj, issue);
  }
  next.pass = scene.pass + 1;
  return next;
};

function applyFix(obj: SceneObject, issue: ReviewIssue): void {
  const { fix: f } = issue;
  switch (f.op) {
    case "move": {
      if (!f.delta) {
        throw new Error(`fix: "move" on "${issue.objectId}" is missing delta`);
      }
      const [px, py, pz] = obj.transform.position;
      obj.transform.position = [px + f.delta[0], py + f.delta[1], pz + f.delta[2]];
      return;
    }
    case "rotate": {
      if (f.rotationYDeg === undefined) {
        throw new Error(`fix: "rotate" on "${issue.objectId}" is missing rotationYDeg`);
      }
      obj.transform.rotationYDeg += f.rotationYDeg;
      return;
    }
    case "resize": {
      if (f.scaleFactor === undefined) {
        throw new Error(`fix: "resize" on "${issue.objectId}" is missing scaleFactor`);
      }
      obj.transform.scale *= f.scaleFactor;
      // Re-seat on the floor at the new scale. `position` is the object CENTER
      // (scene/schema.ts) and a floor-resting center sits at half the object's scaled
      // height — exactly geometryCheck's restY = approxSize·scale/2 (which layout.ts also
      // emits at scale 1). Both renderers place the pivot at position.y and scale the model
      // (base seated at pivot-local -approxSize[1]/2) about it, so the rendered base lands at
      // position.y - scale·approxSize[1]/2. Without this update the stale position.y no longer
      // matches the new scale, so the base sinks (scaleFactor>1) or floats (scaleFactor<1) — in
      // both the live viewer and the headless critic's own render, so the critic would judge a
      // mis-seated scene. Keeping the invariant here rests it for every downstream reader.
      obj.transform.position[1] = (obj.approxSize[1] * obj.transform.scale) / 2;
      return;
    }
    case "regenerate": {
      if (f.newMeshyPrompt) {
        obj.meshyPrompt = f.newMeshyPrompt;
      }
      obj.glbUrl = undefined;
      obj.status = "pending";
      return;
    }
  }
}
