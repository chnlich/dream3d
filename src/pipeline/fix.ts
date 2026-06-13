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
