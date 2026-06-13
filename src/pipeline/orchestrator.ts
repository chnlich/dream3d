import type { GenerateResponse, Pass, ProgressEvent } from "../api/contract";
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
import { launchBrowser, type RenderInput } from "../render/headless";
import { captureViews } from "../render/multiangle/index";
import { criticCameras } from "../render/criticCameras";
import { deriveResponseKey, readCachedResponse, writeCachedResponse } from "./responseCache";

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

// Cache-aware entry point (unchanged signature). In REAL mode an identical request —
// same prompt + amendRounds + mode — is served from the on-disk response cache: the
// first run is live (minutes), every repeat is sub-second and spends ZERO Meshy
// credits. MOCK mode is already instant, so it always runs fresh (memoizing it would
// be a dev footgun). DREAM3D_RESPONSE_CACHE=0 bypasses the cache entirely (both read
// and write). `onEvent` streams progress on a live run; a cache HIT returns instantly
// and emits no events — the server completes the job on promise resolution, not on a
// terminal event, so an empty progress log is correct.
export async function generate(
  prompt: string,
  amendRounds: number,
  mode: Mode = resolveMode(),
  onEvent?: (ev: ProgressEvent) => void,
): Promise<GenerateResponse> {
  const useCache = mode === "real" && process.env.DREAM3D_RESPONSE_CACHE !== "0";
  if (useCache) {
    const key = deriveResponseKey(prompt, amendRounds, mode);
    const cached = readCachedResponse(key);
    if (cached) {
      console.log(`[dream3d] response cache HIT ${key} (mode=${mode}, amendRounds=${amendRounds})`);
      return cached;
    }
    const result = await runPipeline(prompt, amendRounds, mode, onEvent);
    writeCachedResponse(key, { prompt, amendRounds, mode }, result);
    return result;
  }
  return runPipeline(prompt, amendRounds, mode, onEvent);
}

// The live pipeline — formerly the body of generate(), moved verbatim. mode is passed
// explicitly (the cache gate already resolved it) and onEvent is threaded straight
// through so a live run still streams progress.
async function runPipeline(
  prompt: string,
  amendRounds: number,
  mode: Mode,
  onEvent?: (ev: ProgressEvent) => void,
): Promise<GenerateResponse> {
  const { planner, assetProvider, visionCritic } = implsFor(mode);

  onEvent?.({ kind: "plan" });
  const plan = await planner.plan(prompt);
  onEvent?.({ kind: "plan_done", objectCount: plan.objects.length });

  const total = plan.objects.length;
  let completed = 0; // single-threaded JS: no race on the shared counter across concurrent assets.
  const assets = await mapWithConcurrency(plan.objects, ASSET_CONCURRENCY, async (obj, index) => {
    onEvent?.({ kind: "asset_start", index, total, label: obj.label });
    const asset = await assetProvider.generate(obj);
    completed++;
    onEvent?.({ kind: "asset_done", index, total, completed, label: obj.label });
    return asset;
  });

  let scene = layout(plan);
  onEvent?.({ kind: "layout" });
  scene.objects.forEach((obj, index) => {
    obj.glbUrl = assets[index].glbUrl;
    obj.status = "ready";
  });

  const passes: Pass[] = [{ sceneState: structuredClone(scene) }];

  // REAL mode renders the working scene from several angles each round so the vision
  // critic judges a correctly-scaled, multi-view scene; one warm browser is reused
  // across every round and closed in the finally. MOCK mode ignores images and
  // never launches a browser (its critic gets views: []).
  const browser = mode === "real" ? await launchBrowser() : null;
  try {
    for (let round = 1; round <= amendRounds; round++) {
      if (mode === "real") {
        onEvent?.({ kind: "render", round });
      }
      const views = browser ? await captureSceneViews(scene, browser) : [];
      const issues = [...geometryCheck(scene), ...(await visionCritic.review({ scene, views }))];
      onEvent?.({ kind: "critique", round, issueCount: issues.length });
      if (issues.length === 0) {
        onEvent?.({ kind: "clean", round });
        break;
      }
      scene = fix(scene, issues);
      onEvent?.({ kind: "fix", round, issueCount: issues.length });
      passes.push({ sceneState: structuredClone(scene) });
    }
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  onEvent?.({ kind: "done", passCount: passes.length });
  return { passes };
}

// REAL path only: render the working scene from the critic's framing angles over the
// warm browser, returning one labeled PNG data URL per view for the vision critic.
async function captureSceneViews(scene: SceneState, browser: any): Promise<{ name: string; dataUrl: string }[]> {
  const shots = await captureViews(toRenderInput(scene), criticCameras(scene.room), { browser });
  return shots.map((s) => ({ name: s.name, dataUrl: `data:image/png;base64,${s.png.toString("base64")}` }));
}

// Maps the working SceneState -> the headless render harness's RenderInput, carrying
// approxSize so the render page normalizes each model to its intended bbox.
function toRenderInput(scene: SceneState): RenderInput {
  return {
    room: scene.room,
    objects: scene.objects.map((obj) => ({
      glbUrl: obj.glbUrl,
      primitive: obj.glbUrl ? undefined : "box",
      position: obj.transform.position,
      rotationYDeg: obj.transform.rotationYDeg,
      scale: obj.transform.scale,
      approxSize: obj.approxSize,
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
