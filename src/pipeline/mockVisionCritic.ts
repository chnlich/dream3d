import type { VisionCritic } from "./types";
import type { ReviewIssue, SceneObject, SceneState } from "../scene/schema";

// Offline, deterministic stand-in for the Claude-vision critic. It reads the
// layout JSON only (the screenshot is ignored) and returns a single plausible
// facing nudge: the object whose orientation is furthest from facing the room
// center gets a `rotate` Fix toward it. Returning exactly one issue for any
// non-empty scene keeps the amend loop progressing one object at a time.
export const mockVisionCritic: VisionCritic = {
  async review({ scene }: { scene: SceneState; screenshotDataUrl: string }): Promise<ReviewIssue[]> {
    if (scene.objects.length === 0) {
      return [];
    }

    let worst: SceneObject = scene.objects[0];
    let worstDelta = 0;
    for (const obj of scene.objects) {
      const delta = facingErrorDeg(obj);
      if (Math.abs(delta) > Math.abs(worstDelta)) {
        worst = obj;
        worstDelta = delta;
      }
    }

    return [
      {
        objectId: worst.id,
        kind: "wrong_facing",
        severity: "low",
        description: `${worst.label} should turn to face the center of the room`,
        fix: { op: "rotate", rotationYDeg: Math.round(worstDelta) },
        source: "vision",
      },
    ];
  },
};

// Shortest signed yaw (deg) the object must add to point its front (-Z at yaw 0)
// toward the room center at the origin.
function facingErrorDeg(obj: SceneObject): number {
  const [x, , z] = obj.transform.position;
  const desiredYaw = (Math.atan2(-x, -z) * 180) / Math.PI;
  return normalizeDeg(desiredYaw - obj.transform.rotationYDeg);
}

function normalizeDeg(deg: number): number {
  let normalized = deg % 360;
  if (normalized > 180) {
    normalized -= 360;
  }
  if (normalized < -180) {
    normalized += 360;
  }
  return normalized;
}
