// planCache.ts — backend plan-level cache for the pipeline planner.
//
// runPipeline() calls planner.plan(prompt) — a headless Opus CLI call that emits a
// FRESH, non-deterministic meshyPrompt for every object on every run. Downstream,
// meshyAssetProvider's per-asset Meshy cache is keyed on that meshyPrompt, so it
// NEVER hits across runs and every run regenerates all GLBs (Meshy credits +
// minutes). Memoizing the PLAN keyed by the request (prompt + mode) makes the
// meshyPrompts stable, so the existing Meshy cache hits and assets are reused.
//
// This sits ONE layer below responseCache: the response cache short-circuits a
// whole identical /api/generate call, while this stabilizes the plan so even a
// request that differs only in amendRounds (a response-cache miss) still reuses
// assets. That is why amendRounds is INTENTIONALLY NOT part of the key — the plan
// is independent of amendRounds; only the amend loop downstream depends on it.
//
// The on-disk envelope, sha256 key scheme, atomic write, and throw-on-corrupt vs
// null-on-expected-staleness read split all come from the shared diskCache helper;
// this module supplies only the plan-specific bits (dir, version, and a shape check).
// Unlike responseCache there are no glbUrls to validate — a plan carries no asset paths.

import type { ScenePlan } from "../scene/schema";
import { normalizePrompt } from "../meshy/cache.mjs";
import { createDiskCache } from "./diskCache";

// Bumped when the envelope shape or the ScenePlan contract changes. Folded into the
// key (so old entries become unreachable) AND checked on read (so a stale-version
// file regenerates instead of deserializing a wrong shape).
const PLAN_CACHE_VERSION = 1;

const cache = createDiskCache<ScenePlan>({
  dirName: "plans",
  label: "plan",
  valueKey: "plan",
  version: PLAN_CACHE_VERSION,
  validate: validatePlan,
});

// sha256 of [version, mode, normalizedPrompt].join("::"), first 16 hex chars. mode is
// taken as a plain string (the Mode union is assignable to string) to keep this module
// free of any orchestrator import. amendRounds is deliberately absent: the plan does
// not depend on it (see header).
export function derivePlanKey(prompt: string, mode: string): string {
  return cache.deriveKey([mode, normalizePrompt(prompt)]);
}

// Returns the cached plan for `key`, or null on an EXPECTED miss: no file, or a
// stale PLAN_CACHE_VERSION. THROWS on a corrupt file (unparseable JSON, or a
// malformed envelope) — that is a bug, not a miss, and must surface loudly rather
// than silently regenerate.
export function readCachedPlan(key: string): ScenePlan | null {
  return cache.read(key);
}

// Persists `plan` under `key` inside an envelope carrying PLAN_CACHE_VERSION and
// human-readable provenance (prompt/normalizedPrompt/mode/savedAt).
export function writeCachedPlan(key: string, meta: { prompt: string; mode: string }, plan: ScenePlan): void {
  cache.write(key, { prompt: meta.prompt, normalizedPrompt: normalizePrompt(meta.prompt), mode: meta.mode }, plan);
}

// Gate + lookup helper, symmetric with generate()'s response-cache gate in the
// orchestrator: REAL mode only, and DREAM3D_PLAN_CACHE=0 bypasses entirely (read AND
// write). On a real-mode miss it runs `planFn`, persists the plan, and returns it; on
// a hit it logs and returns the cached plan; in mock or when bypassed it runs
// `planFn` directly with no cache. Keeps the orchestrator diff to one line.
export async function getOrCreatePlan(
  prompt: string,
  mode: string,
  planFn: () => Promise<ScenePlan>,
): Promise<ScenePlan> {
  const useCache = mode === "real" && process.env.DREAM3D_PLAN_CACHE !== "0";
  if (!useCache) {
    return planFn(); // mock mode, or explicitly bypassed — always run a fresh plan
  }
  const key = derivePlanKey(prompt, mode);
  const cached = readCachedPlan(key);
  if (cached) {
    console.log(`[dream3d] plan cache HIT ${key} (mode=${mode})`);
    return cached;
  }
  const plan = await planFn();
  writeCachedPlan(key, { prompt, mode }, plan);
  return plan;
}

// Value validator for the disk cache. THROWS on a malformed plan envelope (a bug,
// not a miss); a well-formed plan is always fresh (no asset paths to re-check).
function validatePlan(value: unknown, path: string): boolean {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { objects?: unknown }).objects)) {
    throw new Error(`Corrupt plan cache ${path}: "plan" is not an object with an "objects" array`);
  }
  return true;
}
