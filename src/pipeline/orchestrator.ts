import type { GenerateResponse, Pass, ProgressEvent } from "../api/contract";
import type { SceneState } from "../scene/schema";
import { layout } from "./layout";
import { geometryCheck } from "./geometryCheck";
import { fix } from "./fix";
import { claudePlanner } from "./claudePlanner";
import { meshyAssetProvider } from "./meshyAssetProvider";
import { claudeVisionCritic } from "./claudeVisionCritic";
import { launchBrowser, type RenderInput } from "../render/headless";
import { captureViews } from "../render/multiangle/index";
import { criticCameras } from "../render/criticCameras";
import { deriveResponseKey, readCachedResponse, writeCachedResponse } from "./responseCache";
import { getOrCreatePlan } from "./planCache";

// The agentic loop: plan -> assets -> layout -> [render -> geometry + vision ->
// fix] x amendRounds. The response always carries amendRounds + 1 passes (the
// draft plus one per amend round); every pushed sceneState is a deep clone so the
// mutable working object is never shared across passes.

const ASSET_CONCURRENCY = 3;

// Cache-aware entry point. An identical request — same prompt + amendRounds — is
// served from the on-disk response cache: the first run is live (minutes), every
// repeat is sub-second and spends ZERO Meshy credits. DREAM3D_RESPONSE_CACHE=0
// bypasses the cache entirely (both read and write). `onEvent` streams progress
// on a live run; a cache HIT returns instantly and emits no events — the server
// completes the job on promise resolution, not on a terminal event, so an empty
// progress log is correct.
export async function generate(
  prompt: string,
  amendRounds: number,
  onEvent?: (ev: ProgressEvent) => void,
): Promise<GenerateResponse> {
  const useCache = process.env.DREAM3D_RESPONSE_CACHE !== "0";
  if (useCache) {
    const key = deriveResponseKey(prompt, amendRounds);
    const cached = readCachedResponse(key);
    if (cached) {
      console.log(`[dream3d] response cache HIT ${key} (amendRounds=${amendRounds})`);
      return cached;
    }
    const result = await runPipeline(prompt, amendRounds, onEvent);
    writeCachedResponse(key, { prompt, amendRounds }, result);
    return result;
  }
  return runPipeline(prompt, amendRounds, onEvent);
}

// The live pipeline. `onEvent` is threaded straight through so a live run still
// streams progress.
async function runPipeline(
  prompt: string,
  amendRounds: number,
  onEvent?: (ev: ProgressEvent) => void,
): Promise<GenerateResponse> {
  onEvent?.({ kind: "plan" });
  const plan = await getOrCreatePlan(prompt, () => claudePlanner.plan(prompt));
  onEvent?.({ kind: "plan_done", objectCount: plan.objects.length });

  const total = plan.objects.length;
  let completed = 0; // single-threaded JS: no race on the shared counter across concurrent assets.
  const assets = await mapWithConcurrency(plan.objects, ASSET_CONCURRENCY, async (obj, index) => {
    onEvent?.({ kind: "asset_start", index, total, label: obj.label });
    const asset = await meshyAssetProvider.generate(obj);
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

  // Render the working scene from several angles each round so the vision critic
  // judges a correctly-scaled, multi-view scene; one warm browser is reused across
  // every round and closed in the finally.
  const browser = await launchBrowser();
  try {
    for (let round = 1; round <= amendRounds; round++) {
      onEvent?.({ kind: "render", round });
      const views = await captureSceneViews(scene, browser);
      const issues = [...geometryCheck(scene), ...(await claudeVisionCritic.review({ scene, views }))];
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
    await browser.close();
  }

  onEvent?.({ kind: "done", passCount: passes.length });
  return { passes };
}

// Render the working scene from the critic's framing angles over the warm
// browser, returning one labeled PNG data URL per view for the vision critic.
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
