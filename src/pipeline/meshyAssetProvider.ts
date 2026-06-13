import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AssetProvider } from "./types";
import type { PlannedObject } from "../scene/schema";
import { createMeshyClient } from "../meshy/client";
import { loadConfig } from "../config";
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

// Cache-aware Meshy asset provider. A cache hit is served straight off disk with
// ZERO network calls and ZERO Meshy credits; the returned glbUrl is the local
// filesystem path of the chosen .glb (the headless renderer accepts a local path).
// A miss generates a single preview candidate, persists it through the shared
// cache helpers, and returns its local path. Refine mode is out of scope.
export const meshyAssetProvider: AssetProvider = {
  async generate(obj: PlannedObject): Promise<{ glbUrl: string }> {
    const mode = "preview";
    const cacheDir = DEFAULT_CACHE_DIR;
    const key = deriveKey(obj.meshyPrompt, mode);
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
        return { glbUrl: chosen.glb };
      }
    }

    // MISS — load the key now (loud if missing) and generate one preview candidate.
    const client = createMeshyClient(loadConfig().meshyApiKey);
    const taskId = await client.submitPreview(obj.meshyPrompt);
    const task = await client.waitForTask(taskId, { pollIntervalMs: POLL_INTERVAL_MS, timeoutMs: TIMEOUT_MS });
    const glbUrl = task.modelUrls.glb;
    if (!glbUrl) {
      throw new Error(`Meshy task ${task.id} SUCCEEDED without model_urls.glb`);
    }
    const bytes = await client.downloadGlb(glbUrl);

    const dir = join(cacheDir, key);
    await mkdir(dir, { recursive: true });
    const glbPath = join(dir, `${taskId}.glb`);
    await writeFile(glbPath, bytes);

    const candidate: Candidate = {
      taskId,
      prompt: obj.meshyPrompt,
      mode,
      key,
      status: task.status,
      savedAt: Math.floor(Date.now() / 1000),
      glb: glbPath,
      bytes: bytes.byteLength,
    };
    await writeFile(join(dir, `${taskId}.json`), serializeCache(candidate));

    const entry: CacheEntry = index[key] ?? { prompt: obj.meshyPrompt, mode, key, winner: null, candidates: [] };
    entry.candidates.push(candidate);
    index[key] = entry;
    await writeIndex(cacheDir, index);
    await ensureDirMeta(cacheDir, key, { prompt: obj.meshyPrompt, normalizedPrompt, mode });

    return { glbUrl: glbPath };
  },
};
