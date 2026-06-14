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
// Fail loud: a corrupt cache file is a bug, not a miss — it THROWS. Only EXPECTED
// staleness (absent file, version bump) yields a clean null so the caller regenerates.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import type { ScenePlan } from "../scene/schema";
import { normalizePrompt } from "../meshy/cache.mjs";

// Bumped when the envelope shape or the ScenePlan contract changes. Folded into the
// key (so old entries become unreachable) AND checked on read (so a stale-version
// file regenerates instead of deserializing a wrong shape).
const PLAN_CACHE_VERSION = 1;

const plansDir = join(homedir(), ".cache", "dream3d", "plans");

// The on-disk envelope wrapping one cached plan. The provenance fields
// (prompt/normalizedPrompt/mode/savedAt) are human-readable markers — like the
// Meshy cache's <key>/meta.json — not used for lookup.
interface PlanEnvelope {
  version: number;
  key: string;
  prompt: string;
  normalizedPrompt: string;
  mode: string;
  savedAt: number;
  plan: ScenePlan;
}

// sha256 of [version, mode, normalizedPrompt].join("::"), first 16 hex chars — the
// same normalize + "::"-join + slice(0,16) shape as the Meshy and response cache
// keys. mode is taken as a plain string (the Mode union is assignable to string) to
// keep this module free of any orchestrator import. amendRounds is deliberately
// absent: the plan does not depend on it (see header).
export function derivePlanKey(prompt: string, mode: string): string {
  const parts = [String(PLAN_CACHE_VERSION), mode, normalizePrompt(prompt)];
  return createHash("sha256").update(parts.join("::")).digest("hex").slice(0, 16);
}

function planPath(key: string): string {
  return join(plansDir, `${key}.json`);
}

// Returns the cached plan for `key`, or null on an EXPECTED miss: no file, or a
// stale PLAN_CACHE_VERSION. THROWS on a corrupt file (unparseable JSON, or a
// malformed envelope) — that is a bug, not a miss, and must surface loudly rather
// than silently regenerate. Unlike responseCache there are no glbUrls to validate —
// a plan carries no asset paths.
export function readCachedPlan(key: string): ScenePlan | null {
  const path = planPath(key);
  if (!existsSync(path)) {
    return null; // clean miss — nothing cached for this request yet
  }

  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Corrupt plan cache ${path}: JSON parse failed (${(error as Error).message})`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Corrupt plan cache ${path}: envelope is not a JSON object`);
  }
  const envelope = parsed as { version?: unknown; plan?: unknown };

  if (typeof envelope.version !== "number") {
    throw new Error(`Corrupt plan cache ${path}: missing numeric "version"`);
  }
  const plan = envelope.plan;
  if (typeof plan !== "object" || plan === null || !Array.isArray((plan as { objects?: unknown }).objects)) {
    throw new Error(`Corrupt plan cache ${path}: "plan" is not an object with an "objects" array`);
  }

  if (envelope.version !== PLAN_CACHE_VERSION) {
    return null; // expected staleness — regenerate under the current version
  }

  return plan as ScenePlan;
}

// Persists `plan` under `key` inside an envelope carrying PLAN_CACHE_VERSION and
// human-readable provenance. Atomic: writes a .tmp sibling then renames it into
// place, so a concurrent reader never observes a half-written file.
export function writeCachedPlan(key: string, meta: { prompt: string; mode: string }, plan: ScenePlan): void {
  mkdirSync(plansDir, { recursive: true });
  const envelope: PlanEnvelope = {
    version: PLAN_CACHE_VERSION,
    key,
    prompt: meta.prompt,
    normalizedPrompt: normalizePrompt(meta.prompt),
    mode: meta.mode,
    savedAt: Math.floor(Date.now() / 1000),
    plan,
  };
  const finalPath = planPath(key);
  const tmpPath = `${finalPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(envelope, null, 2));
  renameSync(tmpPath, finalPath);
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
