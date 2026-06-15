// responseCache.ts — backend response-level cache for /api/generate.
//
// orchestrator.generate() runs a live, minutes-long pipeline (headless Opus
// planner + Meshy preview->refine). The per-asset Meshy cache does NOT help a
// repeated /api/generate call: the planner emits a fresh meshyPrompt every run,
// so the Meshy key always misses. Memoizing the WHOLE response keyed by the
// request (prompt + amendRounds) fixes it — the first run is live, every
// identical request after is served from disk in well under a second.
//
// This stores the orchestrator's RAW output, whose ready glbUrls are LOCAL Meshy
// cache paths (PRE-bridge). The /assets bridge (publishSceneAssets) runs AFTER
// generate() returns and re-links + rewrites on every serve, so the two layers
// compose and this module stays out of the bridge's way.
//
// The on-disk envelope, sha256 key scheme, atomic write, and throw-on-corrupt vs
// null-on-expected-staleness read split all come from the shared diskCache helper;
// this module supplies only the response-specific bits (dir, version, and the
// glbUrl-on-disk validation below).

import { existsSync } from "node:fs";

import type { GenerateResponse } from "../api/contract";
import { normalizePrompt } from "../meshy/cache.mjs";
import { createDiskCache } from "./diskCache";

// Bumped when the envelope shape or the orchestrator output contract changes.
// Folded into the key (so old entries become unreachable) AND checked on read
// (so a stale-version file regenerates instead of deserializing a wrong shape).
const CACHE_VERSION = 1;

const cache = createDiskCache<GenerateResponse>({
  dirName: "responses",
  label: "response",
  valueKey: "response",
  version: CACHE_VERSION,
  validate: validateResponse,
});

// sha256 of [version, amendRounds, normalizedPrompt].join("::"), first 16 hex
// chars.
export function deriveResponseKey(prompt: string, amendRounds: number): string {
  return cache.deriveKey([String(amendRounds), normalizePrompt(prompt)]);
}

// Returns the cached response for `key`, or null on an EXPECTED miss: no file, a
// stale CACHE_VERSION, or a referenced local GLB that has been evicted. THROWS on
// a corrupt file (unparseable JSON, or a malformed envelope) — that is a bug, not
// a miss, and must surface loudly rather than silently regenerate.
export function readCachedResponse(key: string): GenerateResponse | null {
  return cache.read(key);
}

// Persists `response` under `key` inside an envelope carrying CACHE_VERSION and
// human-readable provenance (prompt/normalizedPrompt/amendRounds/savedAt).
export function writeCachedResponse(
  key: string,
  meta: { prompt: string; amendRounds: number },
  response: GenerateResponse,
): void {
  cache.write(
    key,
    { prompt: meta.prompt, normalizedPrompt: normalizePrompt(meta.prompt), amendRounds: meta.amendRounds },
    response,
  );
}

// Value validator for the disk cache. THROWS on a malformed response envelope (a
// bug, not a miss). Then performs asset-existence validation, mirroring the Meshy
// cache's validCandidatesOnDisk: a ready glbUrl that is a LOCAL path (not an
// http(s) URL, not an already bridged /assets/ URL) must still be on disk. If any
// referenced GLB was evicted, the cached response is unusable -> returns false so
// the caller regenerates.
function validateResponse(value: unknown, path: string): boolean {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { passes?: unknown }).passes)) {
    throw new Error(`Corrupt response cache ${path}: "response" is not an object with a "passes" array`);
  }
  const response = value as GenerateResponse;
  for (const pass of response.passes) {
    for (const obj of pass.sceneState.objects) {
      const glbUrl = obj.glbUrl;
      if (typeof glbUrl !== "string" || glbUrl.length === 0) {
        continue;
      }
      if (glbUrl.startsWith("http://") || glbUrl.startsWith("https://") || glbUrl.startsWith("/assets/")) {
        continue;
      }
      if (!existsSync(glbUrl)) {
        return false; // a referenced local GLB was evicted — regenerate
      }
    }
  }
  return true;
}
