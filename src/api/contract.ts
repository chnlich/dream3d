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

// Progress events streamed by the orchestrator during a run (plan -> assets -> layout -> amend loop).
// A discriminated union on `kind`; the server renders each to an English log line (see formatEvent).
export type ProgressEvent =
  | { kind: "plan" }
  | { kind: "plan_done"; objectCount: number }
  | { kind: "asset_start"; index: number; total: number; label: string }
  | { kind: "asset_done"; index: number; total: number; completed: number; label: string }
  | { kind: "layout" }
  | { kind: "render"; round: number }
  | { kind: "critique"; round: number; issueCount: number }
  | { kind: "fix"; round: number; issueCount: number }
  | { kind: "clean"; round: number }
  | { kind: "done"; passCount: number };

// One rendered progress line, timestamped server-side (Date.now()) when the event fired.
export interface LogLine {
  ts: number;
  text: string;
}

// 202 body of POST /api/generate: the id to poll for progress + result.
export interface JobStartResponse {
  jobId: string;
}

// 200 body of GET /api/generate/<jobId>: the live job snapshot. `result` is present once `status`
// is "done"; `error` is present once `status` is "error".
export interface JobStatus {
  status: "running" | "done" | "error";
  log: LogLine[];
  result?: GenerateResponse;
  error?: string;
}
