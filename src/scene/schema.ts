export type Vec3 = [number, number, number]; // meters, Y-up, floor at y=0

export interface Room { width: number; depth: number; height: number; } // X / Z / Y

export interface Transform {
  position: Vec3;        // object CENTER, world space
  rotationYDeg: number;  // yaw in DEGREES (viewer converts to radians)
  scale: number;         // uniform multiplier on top of approxSize-normalization (1 = exactly approxSize)
}

export interface PlannedObject {
  id: string;
  label: string;
  meshyPrompt: string;   // single object, no scene context
  approxSize: Vec3;      // intended bbox (m) -> drives GLB scale normalization
  position: Vec3;
  rotationYDeg: number;
}

export interface ScenePlan { prompt: string; room: Room; objects: PlannedObject[]; }

export type ObjectStatus = "pending" | "ready" | "failed";

export interface SceneObject {
  id: string;
  label: string;
  meshyPrompt: string;
  approxSize: Vec3;
  transform: Transform;
  glbUrl?: string;
  status: ObjectStatus;
}

export interface SceneState { room: Room; objects: SceneObject[]; pass: number; }

export type IssueKind =
  | "overlap" | "floating" | "out_of_bounds"
  | "wrong_facing" | "too_big" | "too_small" | "other";
export type Severity = "low" | "medium" | "high";

export interface Fix {
  op: "move" | "rotate" | "resize" | "regenerate";
  delta?: Vec3;            // move (m, added to position)
  rotationYDeg?: number;   // rotate (deg, added)
  scaleFactor?: number;    // resize (x current scale)
  newMeshyPrompt?: string; // regenerate
}

export interface ReviewIssue {
  objectId: string;
  kind: IssueKind;
  severity: Severity;
  description: string;
  fix: Fix;
  source: "geometry" | "vision";
}

export interface ReviewPass {
  pass: number;                 // 0-based
  screenshotDataUrl?: string;   // server-side render of this pass (for UI replay)
  issues: ReviewIssue[];
  fixesApplied: Fix[];
}
