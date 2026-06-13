#!/usr/bin/env node
// meshy-generate.mjs — internal best-of-N text-to-3D generator (cache-aware).
//
// Sends a prompt to the Meshy text-to-3D API and returns several candidate GLB
// models. Caches by prompt+mode so repeat runs are free. Prints a JSON manifest
// on stdout; all logs/progress go to stderr.
//
// Usage:
//   node scripts/meshy-generate.mjs "<prompt>" [--count N] [--mode preview|refine]
//                                   [--add N] [--rebuild] [--cache-dir <path>] [--help|-h]
//
// Reads the Meshy API key from config/local.json at the repo root (gitignored):
//   { "meshyApiKey": "msy_..." }
//
// The cache primitives (key derivation, index I/O, candidate validation, the
// human-readable dir marker, rebuild) live in src/meshy/cache.mjs — the single
// source of truth shared with the pipeline asset provider. See `--help` for the
// full spec. Mirrors the verified flow in meshy-smoke.mjs.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import {
  CHECKPOINT_KEY,
  CHECKPOINT_PROMPT,
  DEFAULT_CACHE_DIR,
  assertKeySchemeIsStable,
  deriveKey,
  ensureDirMeta,
  normalizePrompt,
  readIndex,
  rebuildEntry,
  serializeCache,
  validCandidatesOnDisk,
  writeIndex,
} from "../src/meshy/cache.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const CONFIG_PATH = join(REPO_ROOT, "config", "local.json");

const MESHY_BASE_URL = "https://api.meshy.ai";
const TEXT_TO_3D_PATH = "/openapi/v2/text-to-3d";

const POLL_INTERVAL_MS = 6000;
const TIMEOUT_MS = 5 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 120000;
const SUBMIT_CONCURRENCY = 5;

const DEFAULT_COUNT = 3;
const MIN_COUNT = 1;
const MAX_COUNT = 8;

const CONFIG_HELP =
  `Create ${CONFIG_PATH} with this shape (it is gitignored — never commit it):\n` +
  `  { "meshyApiKey": "msy_..." }`;

// --- config ----------------------------------------------------------------

async function loadMeshyApiKey() {
  let raw;
  try {
    raw = await readFile(CONFIG_PATH, "utf8");
  } catch (error) {
    throw new Error(`Cannot read Meshy config at ${CONFIG_PATH}: ${error.message}\n${CONFIG_HELP}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${CONFIG_PATH} is not valid JSON: ${error.message}\n${CONFIG_HELP}`);
  }
  const key = parsed.meshyApiKey;
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new Error(`${CONFIG_PATH} is missing a non-empty "meshyApiKey".\n${CONFIG_HELP}`);
  }
  return key.trim();
}

// --- Meshy API -------------------------------------------------------------

async function submitJob(apiKey, body) {
  const response = await fetch(`${MESHY_BASE_URL}${TEXT_TO_3D_PATH}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Meshy submit failed: HTTP ${response.status} ${text}`);
  }
  const taskId = JSON.parse(text).result;
  if (typeof taskId !== "string" || taskId.trim().length === 0) {
    throw new Error(`Meshy submit returned no task id: ${text}`);
  }
  return taskId;
}

async function pollTask(apiKey, taskId) {
  const url = `${MESHY_BASE_URL}${TEXT_TO_3D_PATH}/${encodeURIComponent(taskId)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Meshy poll failed: HTTP ${response.status} ${text}`);
  }
  return JSON.parse(text);
}

// Loops until the task succeeds; throws LOUDLY on any terminal failure or timeout.
async function waitForTask(apiKey, taskId, ordinal) {
  const startedAt = Date.now();
  for (;;) {
    const task = await pollTask(apiKey, taskId);
    console.error(`[candidate ${ordinal}] task ${taskId} status=${task.status} progress=${task.progress ?? 0}`);

    if (task.status === "SUCCEEDED") {
      return task;
    }
    if (task.status === "FAILED" || task.status === "CANCELED" || task.status === "EXPIRED") {
      const detail = task.task_error?.message ? `: ${task.task_error.message}` : "";
      throw new Error(`Meshy task ${taskId} ended with ${task.status}${detail}`);
    }
    if (Date.now() - startedAt >= TIMEOUT_MS) {
      throw new Error(`Meshy task ${taskId} timed out after ${TIMEOUT_MS} ms (last status ${task.status})`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

// Downloads a presigned asset URL (NO Authorization header) with a total timeout,
// retrying ONCE — large CDN downloads can stall on this network.
async function downloadWithRetry(url, label) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) {
        throw new Error(`empty payload from ${url}`);
      }
      return bytes;
    } catch (error) {
      if (attempt === 2) {
        throw new Error(`${label} download failed after 2 attempts: ${error.message}`);
      }
      console.error(`  ${label} download attempt ${attempt} failed (${error.message}); retrying once`);
    }
  }
}

// --- candidate generation --------------------------------------------------

// Generates one candidate end-to-end and writes its files into <cacheDir>/<key>/.
// Returns the sidecar object (also embedded into index.json by the caller).
async function generateCandidate(apiKey, { prompt, mode, key, cacheDir }, ordinal) {
  console.error(`[candidate ${ordinal}] submitting preview…`);
  const previewTaskId = await submitJob(apiKey, { mode: "preview", prompt, target_formats: ["glb"] });
  console.error(`[candidate ${ordinal}] preview task ${previewTaskId} submitted; polling…`);
  const previewTask = await waitForTask(apiKey, previewTaskId, ordinal);

  let finalTaskId = previewTaskId;
  let finalTask = previewTask;
  if (mode === "refine") {
    console.error(`[candidate ${ordinal}] submitting refine for preview ${previewTaskId}…`);
    finalTaskId = await submitJob(apiKey, { mode: "refine", preview_task_id: previewTaskId });
    console.error(`[candidate ${ordinal}] refine task ${finalTaskId} submitted; polling…`);
    finalTask = await waitForTask(apiKey, finalTaskId, ordinal);
  }

  const glbUrl = finalTask.model_urls?.glb;
  if (!glbUrl) {
    throw new Error(`Meshy task ${finalTaskId} SUCCEEDED without model_urls.glb`);
  }
  const thumbUrl = finalTask.thumbnail_url;
  if (!thumbUrl) {
    throw new Error(`Meshy task ${finalTaskId} SUCCEEDED without thumbnail_url`);
  }

  const candidateDir = join(cacheDir, key);
  await mkdir(candidateDir, { recursive: true });
  const glbPath = join(candidateDir, `${finalTaskId}.glb`);
  const thumbPath = join(candidateDir, `${finalTaskId}.png`);

  console.error(`[candidate ${ordinal}] downloading glb + thumbnail…`);
  const glbBytes = await downloadWithRetry(glbUrl, `task ${finalTaskId} glb`);
  const thumbBytes = await downloadWithRetry(thumbUrl, `task ${finalTaskId} thumbnail`);
  await writeFile(glbPath, glbBytes);
  await writeFile(thumbPath, thumbBytes);

  const sidecar = {
    taskId: finalTaskId,
    prompt,
    mode,
    key,
    status: finalTask.status,
    savedAt: nowSeconds(),
    glb: glbPath,
    bytes: glbBytes.byteLength,
    thumb: thumbPath,
    seed: finalTask.seed ?? null,
    consumedCredits: finalTask.consumed_credits ?? null,
  };
  await writeFile(join(candidateDir, `${finalTaskId}.json`), serializeCache(sidecar));
  console.error(`[candidate ${ordinal}] done: ${glbPath} (${glbBytes.byteLength} bytes)`);
  return sidecar;
}

// --- manifest --------------------------------------------------------------

function buildManifest({ prompt, mode }, normalizedPrompt, key, cacheDir, fromCache, candidates) {
  return {
    prompt,
    normalizedPrompt,
    key,
    mode,
    fromCache,
    cacheDir,
    candidates: candidates.map((candidate) => ({
      taskId: candidate.taskId,
      glb: candidate.glb ?? null,
      thumbnail: candidate.thumb ?? null,
      seed: candidate.seed ?? null,
      consumedCredits: candidate.consumedCredits ?? null,
      bytes: candidate.bytes ?? null,
      status: candidate.status,
    })),
  };
}

function printManifest(manifest) {
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

// --- args / help -----------------------------------------------------------

function clampCount(n) {
  return Math.max(MIN_COUNT, Math.min(MAX_COUNT, n));
}

function parseArgs(argv) {
  const opts = {
    prompt: null,
    count: DEFAULT_COUNT,
    mode: "preview",
    cacheDir: DEFAULT_CACHE_DIR,
    addRequested: false,
    add: null, // resolved (clamped) extra-candidate count for --add; null until resolved
    rebuild: false,
  };
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--rebuild") {
      opts.rebuild = true;
    } else if (arg === "--add") {
      opts.addRequested = true;
      // An explicit integer (incl. a leading "-") is consumed as N; otherwise N is
      // omitted and falls back to --count once all args are parsed.
      const next = argv[i + 1];
      if (next !== undefined && /^-?\d+$/.test(next)) {
        opts.add = clampCount(Number(next));
        i++;
      }
    } else if (arg === "--count") {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error("--count requires a number");
      }
      const n = Number(value);
      if (!Number.isInteger(n)) {
        throw new Error(`--count must be an integer, got "${value}"`);
      }
      opts.count = clampCount(n);
    } else if (arg === "--mode") {
      const value = argv[++i];
      if (value !== "preview" && value !== "refine") {
        throw new Error(`--mode must be "preview" or "refine", got "${value}"`);
      }
      opts.mode = value;
    } else if (arg === "--cache-dir") {
      const value = argv[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("--cache-dir requires a path");
      }
      opts.cacheDir = expandTilde(value);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg} (run with --help for usage)`);
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length === 0) {
    throw new Error("Missing required <prompt>. Run with --help for usage.");
  }
  if (positionals.length > 1) {
    throw new Error(`Unexpected extra argument(s): ${positionals.slice(1).map((a) => JSON.stringify(a)).join(", ")}`);
  }
  if (opts.rebuild && opts.addRequested) {
    throw new Error("--rebuild and --add are mutually exclusive (rebuild already regenerates --count from scratch).");
  }
  // --add with no explicit N tops up by --count (clamped exactly like --count).
  if (opts.addRequested && opts.add === null) {
    opts.add = opts.count;
  }
  opts.prompt = positionals[0];
  return opts;
}

function printHelp() {
  process.stdout.write(
    `meshy-generate — internal best-of-N text-to-3D generator (cache-aware).

Sends a prompt to Meshy.ai and returns several candidate GLB models. Caches by
prompt+mode so repeat runs are free. Prints a JSON manifest on stdout.

USAGE:
  node scripts/meshy-generate.mjs "<prompt>" [options]

OPTIONS:
  --count N              Number of candidates to return (default ${DEFAULT_COUNT}; clamped to ${MIN_COUNT}..${MAX_COUNT}).
  --mode preview|refine  Generation mode (default preview).
                           preview = N untextured gray meshes.
                           refine  = N textured candidates; each runs a preview
                                     pass then a refine pass on that preview.
  --add N                Generate N MORE candidates and APPEND them to the cached
                         pool. Ignores existing candidates for the cache decision
                         (it always generates — never a pure hit) but still writes
                         results to the cache. N is clamped to ${MIN_COUNT}..${MAX_COUNT}; if omitted it
                         falls back to --count.
  --rebuild              Discard the cached entry for this prompt+mode (delete its
                         <key>/ dir and its index.json record), then regenerate
                         --count candidates from scratch.
  --cache-dir <path>     Cache directory (default ~/.cache/dream3d/meshy; ~ expands).
  --help, -h             Print this help and exit 0 (no key or network needed).

REQUIREMENTS:
  - Node 18+ (uses global fetch and AbortSignal.timeout).
  - config/local.json at the repo root, shape: { "meshyApiKey": "msy_..." }
    (gitignored — never commit it). Required only when generating; a pure cache
    hit needs no key and makes no network calls.
  - Network egress to api.meshy.ai (submit/poll) AND assets.meshy.ai (presigned
    GLB + thumbnail downloads).

COST (Meshy credits):
  - preview candidate: ~20 credits.
  - refine candidate:  ~20 (preview) + ~10 (refine) = ~30 credits.
  - Examples: --count 3 --mode preview  ≈ 60 credits;
              --count 3 --mode refine   ≈ 90 credits;
              --add 2   --mode preview  ≈ 40 credits (always generates N).
  - Cached candidates cost 0.

CACHE:
  - key = sha256(normalizedPrompt + "::" + mode) hex, first 16 chars, where
    normalizedPrompt = prompt.trim().toLowerCase() with every run of whitespace
    collapsed to a single space.
    (e.g. key(${JSON.stringify(CHECKPOINT_PROMPT)},"preview") = ${CHECKPOINT_KEY})
  - Default dir: ~/.cache/dream3d/meshy
  - Layout: <cacheDir>/<key>/<taskId>.glb , <taskId>.png , <taskId>.json (sidecar);
            <cacheDir>/<key>/meta.json — a human-readable directory marker
              ({ key, prompt, normalizedPrompt, mode }) so a person can identify a
              hash-named dir without recomputing sha256;
            <cacheDir>/index.json maps key -> { prompt, mode, key, winner, candidates }.
  - HIT  (default run AND >= count candidates whose .glb exist on disk):
         return them, fromCache:true, ZERO API calls. The dir's meta.json is
         backfilled on the way out (a single local write; still zero network).
  - MISS / too few: generate the shortfall (count minus existing valid
         candidates) and write the new candidates into the cache.
  - --add N: always generate N more and append to the pool (writes to cache).
  - --rebuild: wipe the entry, then generate count candidates from scratch.

OUTPUT:
  - stdout = the JSON manifest ONLY (callers parse it). All logs/progress -> stderr.
  - manifest = {
      prompt, normalizedPrompt, key, mode, fromCache, cacheDir,
      candidates: [ { taskId, glb, thumbnail, seed, consumedCredits, bytes, status } ]
    }
  - On error: prints { "error": "<msg>" } to stderr.

EXIT CODES:
  0         success (generated or served from cache).
  non-zero  any error (missing key, bad args, API/download failure, timeout).

EXAMPLES:
  # 3 preview candidates (default), cache-aware:
  node scripts/meshy-generate.mjs "a small wooden stool"

  # Top up the cached pool with 2 more textured candidates:
  node scripts/meshy-generate.mjs "a brass desk lamp" --count 5 --mode refine --add 2

  # Throw away the cached entry and regenerate 3 fresh candidates:
  node scripts/meshy-generate.mjs "a potted cactus" --rebuild

  # Pipe the first candidate's GLB path into another tool:
  node scripts/meshy-generate.mjs "a potted cactus" | jq -r '.candidates[0].glb'
`,
  );
}

// --- small helpers ---------------------------------------------------------

function expandTilde(path) {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Runs `worker` over `items` with at most `limit` in flight; preserves order.
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }
  const runners = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    runners.push(runner());
  }
  await Promise.all(runners);
  return results;
}

// --- main ------------------------------------------------------------------

async function main() {
  assertKeySchemeIsStable();

  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("--help")) {
    printHelp();
    return;
  }

  const opts = parseArgs(argv);
  const normalizedPrompt = normalizePrompt(opts.prompt);
  const key = deriveKey(opts.prompt, opts.mode);
  const { cacheDir } = opts;

  console.error(`prompt: ${JSON.stringify(opts.prompt)}`);
  const modeNote = opts.rebuild ? " rebuild" : opts.addRequested ? ` add=${opts.add}` : "";
  console.error(`mode=${opts.mode} count=${opts.count} key=${key}${modeNote}`);
  console.error(`cacheDir=${cacheDir}`);

  // --rebuild: wipe the dir + index record up front, then fall through to generate.
  if (opts.rebuild) {
    await rebuildEntry(cacheDir, key);
    console.error(`rebuild: wiped ${join(cacheDir, key)} and dropped index[${key}]`);
  }

  const index = await readIndex(cacheDir);
  const existingValid = validCandidatesOnDisk(index[key] ? index[key].candidates : []);
  console.error(`cache: ${existingValid.length} valid candidate(s) on disk for key ${key}`);

  // CACHE HIT — serve from disk, no key, no network. Not for --add / --rebuild,
  // which always generate. Backfill the human-readable dir marker on the way out
  // (a single local write; still zero network).
  if (!opts.addRequested && !opts.rebuild && existingValid.length >= opts.count) {
    await ensureDirMeta(cacheDir, key, { prompt: opts.prompt, normalizedPrompt, mode: opts.mode });
    console.error(`cache HIT — returning ${opts.count} cached candidate(s), zero API calls`);
    printManifest(buildManifest(opts, normalizedPrompt, key, cacheDir, true, existingValid.slice(0, opts.count)));
    return;
  }

  // Generate. --add N => exactly N new; otherwise the shortfall to reach --count
  // (for --rebuild the entry was just wiped, so the shortfall is the full count).
  const shortfall = opts.addRequested ? opts.add : opts.count - existingValid.length;
  console.error(
    opts.addRequested
      ? `--add — generating ${shortfall} additional candidate(s)`
      : opts.rebuild
        ? `--rebuild — generating ${shortfall} candidate(s) from scratch`
        : `cache MISS/partial — generating ${shortfall} new candidate(s)`,
  );
  // Load the key now (loud if missing); no API call has been made before this point.
  const apiKey = await loadMeshyApiKey();

  const ordinals = Array.from({ length: shortfall }, (_, i) => i + 1);
  const newSidecars = await mapWithConcurrency(ordinals, SUBMIT_CONCURRENCY, (ordinal) =>
    generateCandidate(apiKey, { prompt: opts.prompt, mode: opts.mode, key, cacheDir }, ordinal),
  );

  // Persist to the cache as a single writer, after every candidate has completed.
  if (!index[key]) {
    index[key] = { prompt: opts.prompt, mode: opts.mode, key, winner: null, candidates: [] };
  }
  index[key].candidates.push(...newSidecars);
  await writeIndex(cacheDir, index);
  await ensureDirMeta(cacheDir, key, { prompt: opts.prompt, normalizedPrompt, mode: opts.mode });
  console.error(`cache: wrote ${newSidecars.length} candidate(s) and updated ${join(cacheDir, "index.json")}`);

  const returned = [...existingValid, ...newSidecars];
  printManifest(buildManifest(opts, normalizedPrompt, key, cacheDir, false, returned));
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: error.message ?? String(error) })}\n`);
  process.exit(1);
});
