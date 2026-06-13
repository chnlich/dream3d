import type { ScenePlan, SceneState, ReviewIssue, PlannedObject } from "../scene/schema";

export interface Planner { plan(prompt: string): Promise<ScenePlan>; }
export interface AssetProvider { generate(obj: PlannedObject): Promise<{ glbUrl: string }>; }
export interface VisionCritic {
  review(input: { scene: SceneState; views: { name: string; dataUrl: string }[] }): Promise<ReviewIssue[]>;
}

export type LayoutFn = (plan: ScenePlan) => SceneState;
export type GeomCheckFn = (scene: SceneState) => ReviewIssue[];
export type ApplyFixFn = (scene: SceneState, issues: ReviewIssue[]) => SceneState;
