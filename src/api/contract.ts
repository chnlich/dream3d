import type { SceneState, ReviewPass } from "../scene/schema";

export interface GenerateRequest { prompt: string; }
export interface GenerateResponse { scene: SceneState; trace: ReviewPass[]; }
