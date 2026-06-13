// responseCache.ts — backend response-level cache for /api/generate.
//
// orchestrator.generate() runs a live, minutes-long pipeline (headless Opus
// planner + Meshy preview->refine). The per-asset Meshy cache does NOT help a
// repeated /api/generate call: the planner emits a fresh meshyPrompt every run,
// so the Meshy key always misses. Memoizing the WHOLE response keyed by the
// request (prompt + amendRounds + mode) fixes it — the first run is live, every
// identical request after is served from disk in well under a second.
//
// This stores the orchestrator's RAW output, whose ready glbUrls are LOCAL Meshy
// cache paths (PRE-bridge). The /assets bridge (publishSceneAssets) runs AFTER
// generate() returns and re-links + rewrites on every serve, so the two layers
// compose and this module stays out of the bridge's way.
//
// Fail loud: a corrupt cache file is a bug, not a miss — it THROWS. Only EXPECTED
// staleness (absent file, version bump, evicted GLBs) yields a clean null so the
// caller regenerates.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import type { GenerateResponse } from "../api/contract";
import { normalizePrompt } from "../meshy/cache.mjs";

// Bumped when the envelope shape or the orchestrator output contract changes.
// Folded into the key (so old entries become unreachable) AND checked on read
// (so a stale-version file regenerates instead of deserializing a wrong shape).
const CACHE_VERSION = 1;

const responsesDir = join(homedir(), ".cache", "dream3d", "responses");

// The on-disk envelope wrapping one cached orchestrator response. The provenance
// fields (prompt/normalizedPrompt/mode/amendRounds/savedAt) are human-readable
// markers — like the Meshy cache's <key>/meta.json — not used for lookup.
interface ResponseEnvelope {
  version: number;
  key: string;
  prompt: string;
  normalizedPrompt: string;
  mode: string;
  amendRounds: number;
  savedAt: number;
  response: GenerateResponse;
}

// sha256 of [version, mode, amendRounds, normalizedPrompt].join("::"), first 16
// hex chars — the same normalize + "::"-join + slice(0,16) shape as the Meshy
// cache key. mode is taken as a plain string (the Mode union is assignable to
// string) to keep this module free of any orchestrator import.
export function deriveResponseKey(prompt: string, amendRounds: number, mode: string): string {
  const parts = [String(CACHE_VERSION), mode, String(amendRounds), normalizePrompt(prompt)];
  return createHash("sha256").update(parts.join("::")).digest("hex").slice(0, 16);
}

function responsePath(key: string): string {
  return join(responsesDir, `${key}.json`);
}

// Returns the cached response for `key`, or null on an EXPECTED miss: no file, a
// stale CACHE_VERSION, or a referenced local GLB that has been evicted. THROWS on
// a corrupt file (unparseable JSON, or a malformed envelope) — that is a bug, not
// a miss, and must surface loudly rather than silently regenerate.
export function readCachedResponse(key: string): GenerateResponse | null {
  const path = responsePath(key);
  if (!existsSync(path)) {
    return null; // clean miss — nothing cached for this request yet
  }

  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Corrupt response cache ${path}: JSON parse failed (${(error as Error).message})`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Corrupt response cache ${path}: envelope is not a JSON object`);
  }
  const envelope = parsed as { version?: unknown; response?: unknown };

  if (typeof envelope.version !== "number") {
    throw new Error(`Corrupt response cache ${path}: missing numeric "version"`);
  }
  const response = envelope.response;
  if (typeof response !== "object" || response === null || !Array.isArray((response as { passes?: unknown }).passes)) {
    throw new Error(`Corrupt response cache ${path}: "response" is not an object with a "passes" array`);
  }

  if (envelope.version !== CACHE_VERSION) {
    return null; // expected staleness — regenerate under the current version
  }

  // Asset-existence validation, mirroring the Meshy cache's validCandidatesOnDisk:
  // a ready glbUrl that is a LOCAL path (not an http(s) URL, not an already
  // bridged /assets/ URL) must still be on disk. If any referenced GLB was
  // evicted, the cached response is unusable -> regenerate.
  const validated = response as GenerateResponse;
  for (const pass of validated.passes) {
    for (const obj of pass.sceneState.objects) {
      const glbUrl = obj.glbUrl;
      if (typeof glbUrl !== "string" || glbUrl.length === 0) {
        continue;
      }
      if (glbUrl.startsWith("http://") || glbUrl.startsWith("https://") || glbUrl.startsWith("/assets/")) {
        continue;
      }
      if (!existsSync(glbUrl)) {
        return null; // a referenced local GLB was evicted — regenerate
      }
    }
  }

  return validated;
}

// Persists `response` under `key` inside an envelope carrying CACHE_VERSION and
// human-readable provenance. Atomic: writes a .tmp sibling then renames it into
// place, so a concurrent reader never observes a half-written file.
export function writeCachedResponse(
  key: string,
  meta: { prompt: string; amendRounds: number; mode: string },
  response: GenerateResponse,
): void {
  mkdirSync(responsesDir, { recursive: true });
  const envelope: ResponseEnvelope = {
    version: CACHE_VERSION,
    key,
    prompt: meta.prompt,
    normalizedPrompt: normalizePrompt(meta.prompt),
    mode: meta.mode,
    amendRounds: meta.amendRounds,
    savedAt: Math.floor(Date.now() / 1000),
    response,
  };
  const finalPath = responsePath(key);
  const tmpPath = `${finalPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(envelope, null, 2));
  renameSync(tmpPath, finalPath);
}
