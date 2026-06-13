import type { SceneState } from "../scene/schema";

export interface GenerateRequest {
  prompt: string;
  amendRounds: number; // response has amendRounds + 1 passes
}

// Thin wrapper (not just SceneState[]) so review metadata — issues / fixesApplied —
// can be added later as non-breaking field additions. KISS for now.
export interface Pass {
  sceneState: SceneState;
}

export interface GenerateResponse {
  passes: Pass[]; // length === amendRounds + 1: [draft (p0), then one per amend round]
}
