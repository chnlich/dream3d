import type { GenerateResponse, Pass } from "../api/contract";
import type { SceneState } from "../scene/schema";
import type { AssetProvider, Planner, VisionCritic } from "./types";
import { layout } from "./layout";
import { geometryCheck } from "./geometryCheck";
import { fix } from "./fix";
import { mockPlanner } from "./mockPlanner";
import { mockAssetProvider } from "./mockAssetProvider";
import { mockVisionCritic } from "./mockVisionCritic";
import { claudePlanner } from "./claudePlanner";
import { meshyAssetProvider } from "./meshyAssetProvider";
import { claudeVisionCritic } from "./claudeVisionCritic";
import { renderToPng, type RenderInput } from "../render/headless";

// The agentic loop: plan -> assets -> layout -> [render -> geometry + vision ->
// fix] x amendRounds. The response always carries amendRounds + 1 passes (the
// draft plus one per amend round); every pushed sceneState is a deep clone so the
// mutable working object is never shared across passes.

export type Mode = "mock" | "real";

const ASSET_CONCURRENCY = 3;

// Defaults to MOCK so the backend runs fully offline with no keys. Set
// DREAM3D_MODE=real to drive the Claude/Meshy implementations.
export function resolveMode(): Mode {
  return process.env.DREAM3D_MODE === "real" ? "real" : "mock";
}

interface Impls {
  planner: Planner;
  assetProvider: AssetProvider;
  visionCritic: VisionCritic;
}

function implsFor(mode: Mode): Impls {
  if (mode === "real") {
    return { planner: claudePlanner, assetProvider: meshyAssetProvider, visionCritic: claudeVisionCritic };
  }
  return { planner: mockPlanner, assetProvider: mockAssetProvider, visionCritic: mockVisionCritic };
}

export async function generate(prompt: string, amendRounds: number, mode: Mode = resolveMode()): Promise<GenerateResponse> {
  const { planner, assetProvider, visionCritic } = implsFor(mode);

  const plan = await planner.plan(prompt);
  const assets = await mapWithConcurrency(plan.objects, ASSET_CONCURRENCY, (obj) => assetProvider.generate(obj));

  let scene = layout(plan);
  scene.objects.forEach((obj, index) => {
    obj.glbUrl = assets[index].glbUrl;
    obj.status = "ready";
  });

  const passes: Pass[] = [{ sceneState: structuredClone(scene) }];

  for (let round = 1; round <= amendRounds; round++) {
    const screenshotDataUrl = mode === "real" ? await renderScene(scene) : "";
    const issues = [...geometryCheck(scene), ...(await visionCritic.review({ scene, screenshotDataUrl }))];
    if (issues.length === 0) {
      break;
    }
    scene = fix(scene, issues);
    passes.push({ sceneState: structuredClone(scene) });
  }

  return { passes };
}

// REAL path only: render the working scene to a PNG data URL for the vision
// critic. Maps SceneState -> the headless render harness's RenderInput.
async function renderScene(scene: SceneState): Promise<string> {
  const png = await renderToPng(toRenderInput(scene));
  return `data:image/png;base64,${png.toString("base64")}`;
}

function toRenderInput(scene: SceneState): RenderInput {
  return {
    room: scene.room,
    objects: scene.objects.map((obj) => ({
      glbUrl: obj.glbUrl,
      primitive: obj.glbUrl ? undefined : "box",
      position: obj.transform.position,
      rotationYDeg: obj.transform.rotationYDeg,
      scale: obj.transform.scale,
    })),
  };
}

// Run `fn` over `items` with at most `limit` in flight; results keep input order.
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }
  const pool = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(pool);
  return results;
}
