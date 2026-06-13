import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AssetProvider } from "./types";
import type { PlannedObject } from "../scene/schema";
import { createMeshyClient } from "../meshy/client";
import { loadConfig } from "../config";
import { logEvent } from "../log/audit";
import { PREVIEW_PARAMS, REFINE_PARAMS, paramSignature } from "../meshy/genParams.mjs";
import type { CacheEntry, Candidate } from "../meshy/cache.mjs";
import {
  DEFAULT_CACHE_DIR,
  deriveKey,
  ensureDirMeta,
  normalizePrompt,
  readIndex,
  selectCandidate,
  serializeCache,
  validCandidatesOnDisk,
  writeIndex,
} from "../meshy/cache.mjs";

// Poll cadence / timeout mirror the best-of-N CLI (scripts/meshy-generate.mjs) so
// both paths wait on Meshy identically.
const POLL_INTERVAL_MS = 6000;
const TIMEOUT_MS = 5 * 60 * 1000;

// Cache-aware Meshy asset provider. The asset flow is preview -> refine: a fast
// gray preview mesh (poly-bounded per PREVIEW_PARAMS), then a refine pass that
// BAKES PBR texture onto it (REFINE_PARAMS). The provider persists and returns the
// TEXTURED refined GLB, never the gray preview.
//
// The cache key is the refine-mode key (it folds in a signature of BOTH the
// preview and refine params, since a refined asset depends on the preview mesh).
// A cache hit is served straight off disk with ZERO network calls and ZERO Meshy
// credits; the returned glbUrl is the local filesystem path of the refined .glb
// (the headless renderer accepts a local path). A miss runs preview -> refine,
// persists the refined GLB through the shared cache helpers, and returns its path.
export const meshyAssetProvider: AssetProvider = {
  async generate(obj: PlannedObject): Promise<{ glbUrl: string }> {
    const mode = "refine";
    const cacheDir = DEFAULT_CACHE_DIR;
    const key = deriveKey(obj.meshyPrompt, mode, paramSignature(mode));
    const normalizedPrompt = normalizePrompt(obj.meshyPrompt);

    const index = await readIndex(cacheDir);
    const cached = index[key];
    if (cached) {
      const valid = validCandidatesOnDisk(cached.candidates);
      if (valid.length > 0) {
        // Backfill the human-readable dir marker, then serve from disk.
        await ensureDirMeta(cacheDir, key, { prompt: obj.meshyPrompt, normalizedPrompt, mode });
        const chosen = selectCandidate(cached);
        if (typeof chosen.glb !== "string") {
          throw new Error(`Cache hit for ${key} but selected candidate ${chosen.taskId} has no .glb on disk`);
        }
        logEvent({ kind: "meshy.cache_hit", objId: obj.id, key, glb: chosen.glb });
        return { glbUrl: chosen.glb };
      }
    }

    // MISS — load the key now (loud if missing), then run preview -> refine.
    logEvent({ kind: "meshy.cache_miss", objId: obj.id, key });
    const client = createMeshyClient(loadConfig().meshyApiKey);
    const previewTaskId = await client.submitPreview(obj.meshyPrompt, PREVIEW_PARAMS);
    logEvent({ kind: "meshy.preview_submit", objId: obj.id, taskId: previewTaskId });
    await client.waitForTask(previewTaskId, { pollIntervalMs: POLL_INTERVAL_MS, timeoutMs: TIMEOUT_MS });
    const refineTaskId = await client.submitRefine(previewTaskId, REFINE_PARAMS);
    logEvent({ kind: "meshy.refine_submit", objId: obj.id, previewTaskId, refineTaskId });
    const refined = await client.waitForTask(refineTaskId, { pollIntervalMs: POLL_INTERVAL_MS, timeoutMs: TIMEOUT_MS });
    const glbUrl = refined.modelUrls.glb;
    if (!glbUrl) {
      throw new Error(`Meshy refine task ${refined.id} SUCCEEDED without model_urls.glb`);
    }
    const bytes = await client.downloadGlb(glbUrl);
    logEvent({
      kind: "meshy.done",
      objId: obj.id,
      taskId: refineTaskId,
      status: refined.status,
      bytes: bytes.byteLength,
    });

    const dir = join(cacheDir, key);
    await mkdir(dir, { recursive: true });
    const glbPath = join(dir, `${refineTaskId}.glb`);
    await writeFile(glbPath, bytes);

    const candidate: Candidate = {
      taskId: refineTaskId,
      prompt: obj.meshyPrompt,
      mode,
      key,
      status: refined.status,
      savedAt: Math.floor(Date.now() / 1000),
      glb: glbPath,
      bytes: bytes.byteLength,
    };
    await writeFile(join(dir, `${refineTaskId}.json`), serializeCache(candidate));

    const entry: CacheEntry = index[key] ?? { prompt: obj.meshyPrompt, mode, key, winner: null, candidates: [] };
    entry.candidates.push(candidate);
    index[key] = entry;
    await writeIndex(cacheDir, index);
    await ensureDirMeta(cacheDir, key, { prompt: obj.meshyPrompt, normalizedPrompt, mode });

    return { glbUrl: glbPath };
  },
};
