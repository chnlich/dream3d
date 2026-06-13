// cache.mjs — single source of truth for the dream3d Meshy disk cache.
//
// Pure cache primitives shared by the best-of-N CLI (scripts/meshy-generate.mjs)
// and the pipeline asset provider (src/pipeline/meshyAssetProvider.ts). Plain ESM
// (NO TypeScript syntax) so the CLI keeps running with no build step; the matching
// hand-written type declarations live alongside in cache.d.ts.
//
// Every function here is ZERO-network and has ZERO API-key dependency: a pure
// cache hit needs neither. They only touch the local filesystem under <cacheDir>.

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

export const DEFAULT_CACHE_DIR = join(homedir(), ".cache", "dream3d", "meshy");

// Drift-guard anchor for the key FORMULA (not the live params). CHECKPOINT_PARAM_SIG
// is a FROZEN literal that intentionally does NOT read genParams.mjs: changing a
// real generation param is expected to move real keys, but must not trip this
// check. It just pins normalize + "::"-join + sha256 + slice(0,16). (It happens to
// equal paramSignature("preview") for the params shipped today — illustrative of
// the format — but it is hard-frozen here regardless.)
export const CHECKPOINT_PROMPT = "a small wooden stool";
export const CHECKPOINT_PARAM_SIG =
  '{"ai_model":"meshy-6","should_remesh":true,"target_polycount":300000,"topology":"triangle"}';
export const CHECKPOINT_KEY = "80b6483c5f285dba";

// --- key / prompt normalization -------------------------------------------

export function normalizePrompt(prompt) {
  return prompt.trim().toLowerCase().replace(/\s+/g, " ");
}

// Key = sha256(normalizedPrompt + "::" + mode + "::" + paramSig), first 16 hex
// chars. paramSig is a stable, canonical signature of the output-affecting
// generation params for that mode (see genParams.paramSignature) — folding it in
// means changing any param yields a new key and never silently serves stale bytes.
export function deriveKey(prompt, mode, paramSig) {
  if (typeof paramSig !== "string" || paramSig.length === 0) {
    throw new Error(`deriveKey requires a non-empty paramSig string (got ${JSON.stringify(paramSig)})`);
  }
  const normalized = normalizePrompt(prompt);
  return createHash("sha256").update(`${normalized}::${mode}::${paramSig}`).digest("hex").slice(0, 16);
}

// Guards against the key DERIVATION FORMULA silently drifting. Pinned against a
// frozen prompt + mode + param signature (see CHECKPOINT_PARAM_SIG).
export function assertKeySchemeIsStable() {
  const got = deriveKey(CHECKPOINT_PROMPT, "preview", CHECKPOINT_PARAM_SIG);
  if (got !== CHECKPOINT_KEY) {
    throw new Error(
      `Cache key scheme drifted: key("${CHECKPOINT_PROMPT}","preview",<frozen sig>)=${got}, expected ${CHECKPOINT_KEY}. ` +
        `The key derivation formula changed; newly generated keys would not line up with previously cached entries.`,
    );
  }
}

// --- serialization ---------------------------------------------------------

// Byte-compatible with the seeded cache: 2-space JSON, NO trailing newline.
export function serializeCache(value) {
  return JSON.stringify(value, null, 2);
}

// --- index I/O -------------------------------------------------------------

function indexPath(cacheDir) {
  return join(cacheDir, "index.json");
}

export async function readIndex(cacheDir) {
  let raw;
  try {
    raw = await readFile(indexPath(cacheDir), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return {}; // no cache yet — a legitimate empty state, not a swallowed error
    }
    throw error;
  }
  return JSON.parse(raw); // a corrupt index is a loud failure
}

export async function writeIndex(cacheDir, index) {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(indexPath(cacheDir), serializeCache(index));
}

// --- candidates ------------------------------------------------------------

// Keep only candidates whose .glb is still present on disk.
export function validCandidatesOnDisk(candidates) {
  return candidates.filter((candidate) => typeof candidate.glb === "string" && existsSync(candidate.glb));
}

// The chosen candidate for an entry: the one named by entry.winner if set, else
// the first candidate. Fails loudly if a named winner is missing from the pool.
export function selectCandidate(entry) {
  if (entry.winner) {
    const winner = entry.candidates.find((candidate) => candidate.taskId === entry.winner);
    if (!winner) {
      throw new Error(`cache entry ${entry.key} names winner ${entry.winner}, but no candidate has that taskId`);
    }
    return winner;
  }
  return entry.candidates[0];
}

// --- directory marker ------------------------------------------------------

// Human-readable marker so a person can identify a hash-named dir without
// recomputing sha256. Writes <cacheDir>/<key>/meta.json = { key, prompt,
// normalizedPrompt, mode } only when it does not already exist. Idempotent, no
// network.
export async function ensureDirMeta(cacheDir, key, { prompt, normalizedPrompt, mode }) {
  const dir = join(cacheDir, key);
  await mkdir(dir, { recursive: true });
  const metaPath = join(dir, "meta.json");
  if (existsSync(metaPath)) {
    return;
  }
  await writeFile(metaPath, serializeCache({ key, prompt, normalizedPrompt, mode }));
}

// --- rebuild ---------------------------------------------------------------

// Wipes one cache entry: recursively deletes <cacheDir>/<key>/ and drops
// index[key]. Returns the updated index so the caller can keep using it without
// re-reading. No network.
export async function rebuildEntry(cacheDir, key) {
  await rm(join(cacheDir, key), { recursive: true, force: true });
  const index = await readIndex(cacheDir);
  delete index[key];
  await writeIndex(cacheDir, index);
  return index;
}
