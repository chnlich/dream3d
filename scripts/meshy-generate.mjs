#!/usr/bin/env node
// meshy-generate.mjs — internal best-of-N text-to-3D generator (cache-aware).
//
// Sends a prompt to the Meshy text-to-3D API and returns several candidate GLB
// models. Caches by prompt+mode so repeat runs are free. Prints a JSON manifest
// on stdout; all logs/progress go to stderr.
//
// Usage:
//   node scripts/meshy-generate.mjs "<prompt>" [--count N] [--mode preview|refine]
//                                   [--fresh] [--cache-dir <path>] [--help|-h]
//
// Reads the Meshy API key from config/local.json at the repo root (gitignored):
//   { "meshyApiKey": "msy_..." }
//
// See `--help` for the full spec. Mirrors the verified flow in meshy-smoke.mjs.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

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
const DEFAULT_CACHE_DIR = join(homedir(), ".cache", "dream3d", "meshy");

// Self-test anchor: this key MUST line up with the seeded cache on disk.
const CHECKPOINT_PROMPT = "a small wooden stool";
const CHECKPOINT_KEY = "41b60876785e9b0c";

const CONFIG_HELP =
  `Create ${CONFIG_PATH} with this shape (it is gitignored — never commit it):\n` +
  `  { "meshyApiKey": "msy_..." }`;

// --- key / prompt normalization -------------------------------------------

function normalizePrompt(prompt) {
  return prompt.trim().toLowerCase().replace(/\s+/g, " ");
}

function deriveKey(prompt, mode) {
  const normalized = normalizePrompt(prompt);
  return createHash("sha256").update(`${normalized}::${mode}`).digest("hex").slice(0, 16);
}

// Guards against the key scheme silently drifting away from the seeded cache.
function assertKeySchemeIsStable() {
  const got = deriveKey(CHECKPOINT_PROMPT, "preview");
  if (got !== CHECKPOINT_KEY) {
    throw new Error(
      `Cache key scheme drifted: key("${CHECKPOINT_PROMPT}","preview")=${got}, expected ${CHECKPOINT_KEY}. ` +
        `Newly generated keys would not line up with the seeded cache.`,
    );
  }
}

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

// --- cache I/O -------------------------------------------------------------

async function readIndex(indexPath) {
  let raw;
  try {
    raw = await readFile(indexPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return {}; // no cache yet — a legitimate empty state, not a swallowed error
    }
    throw error;
  }
  return JSON.parse(raw); // a corrupt index is a loud failure
}

function validCandidatesOnDisk(candidates) {
  return candidates.filter((candidate) => typeof candidate.glb === "string" && existsSync(candidate.glb));
}

// Byte-compatible with the seeded cache: 2-space JSON, NO trailing newline.
function serializeCache(value) {
  return JSON.stringify(value, null, 2);
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

function parseArgs(argv) {
  const opts = { prompt: null, count: DEFAULT_COUNT, mode: "preview", useCache: true, cacheDir: DEFAULT_CACHE_DIR };
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--fresh") {
      opts.useCache = false;
    } else if (arg === "--count") {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error("--count requires a number");
      }
      const n = Number(value);
      if (!Number.isInteger(n)) {
        throw new Error(`--count must be an integer, got "${value}"`);
      }
      opts.count = Math.max(MIN_COUNT, Math.min(MAX_COUNT, n));
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
  --fresh                Bypass the cache READ and generate anew. Results are
                         still WRITTEN to the cache. Default: use the cache.
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
              --count 3 --mode refine   ≈ 90 credits.
  - Cached candidates cost 0.

CACHE:
  - key = sha256(normalizedPrompt + "::" + mode) hex, first 16 chars, where
    normalizedPrompt = prompt.trim().toLowerCase() with every run of whitespace
    collapsed to a single space.
    (e.g. key("a small wooden stool","preview") = ${CHECKPOINT_KEY})
  - Default dir: ~/.cache/dream3d/meshy
  - Layout: <cacheDir>/<key>/<taskId>.glb , <taskId>.png , <taskId>.json (sidecar);
            <cacheDir>/index.json maps key -> { prompt, mode, key, winner, candidates }.
  - HIT  (not --fresh AND >= count candidates whose .glb exist on disk):
         return them, fromCache:true, ZERO API calls.
  - MISS / too few / --fresh: generate the shortfall (count minus existing valid
         candidates) and write the new candidates into the cache.

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

  # 5 textured candidates, ignoring any cached results:
  node scripts/meshy-generate.mjs "a brass desk lamp" --count 5 --mode refine --fresh

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
  const indexPath = join(cacheDir, "index.json");

  console.error(`prompt: ${JSON.stringify(opts.prompt)}`);
  console.error(`mode=${opts.mode} count=${opts.count} key=${key} useCache=${opts.useCache}`);
  console.error(`cacheDir=${cacheDir}`);

  const index = await readIndex(indexPath);
  const existingValid = validCandidatesOnDisk(index[key] ? index[key].candidates : []);
  console.error(`cache: ${existingValid.length} valid candidate(s) on disk for key ${key}`);

  // CACHE HIT — serve from disk, no key, no network.
  if (opts.useCache && existingValid.length >= opts.count) {
    console.error(`cache HIT — returning ${opts.count} cached candidate(s), zero API calls`);
    printManifest(buildManifest(opts, normalizedPrompt, key, cacheDir, true, existingValid.slice(0, opts.count)));
    return;
  }

  // MISS / too few / --fresh — generate the shortfall. Load the key now (loud if
  // missing); no API call has been made before this point.
  const shortfall = opts.useCache ? opts.count - existingValid.length : opts.count;
  console.error(
    `cache ${opts.useCache ? "MISS/partial" : "bypassed (--fresh)"} — generating ${shortfall} new candidate(s)`,
  );
  const apiKey = await loadMeshyApiKey();

  const ordinals = Array.from({ length: shortfall }, (_, i) => i + 1);
  const newSidecars = await mapWithConcurrency(ordinals, SUBMIT_CONCURRENCY, (ordinal) =>
    generateCandidate(apiKey, { prompt: opts.prompt, mode: opts.mode, key, cacheDir }, ordinal),
  );

  // Persist to the cache as a single writer, after every candidate has completed.
  await mkdir(cacheDir, { recursive: true });
  if (!index[key]) {
    index[key] = { prompt: opts.prompt, mode: opts.mode, key, winner: null, candidates: [] };
  }
  index[key].candidates.push(...newSidecars);
  await writeFile(indexPath, serializeCache(index));
  console.error(`cache: wrote ${newSidecars.length} candidate(s) and updated ${indexPath}`);

  const returned = opts.useCache ? [...existingValid, ...newSidecars] : newSidecars;
  printManifest(buildManifest(opts, normalizedPrompt, key, cacheDir, false, returned));
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: error.message ?? String(error) })}\n`);
  process.exit(1);
});
