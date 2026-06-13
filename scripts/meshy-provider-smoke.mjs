#!/usr/bin/env node
// meshy-provider-smoke.mjs — exercises the REAL cache-aware Meshy asset provider
// (src/pipeline/meshyAssetProvider.ts), asserting a pure cache HIT.
//
// "a small ceramic mug" (refine) is already seeded in ~/.cache/dream3d/meshy, so
// meshyAssetProvider.generate(...) (which runs preview -> refine on a miss) MUST
// serve the refined GLB from disk: zero network, and the returned glbUrl must
// point to an existing .glb under the cache dir.
//
// The provider is TypeScript (extensionless imports), so we load the real module
// through the tsx ESM loader — NOT a copy of its logic — and call generate()
// directly. Prints PASS/FAIL and exits non-zero on FAIL.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { tsImport } from "tsx/esm/api";

const CACHE_ROOT = join(homedir(), ".cache", "dream3d", "meshy");
const PROVIDER_PATH = "../src/pipeline/meshyAssetProvider.ts";

function fail(message) {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exit(1);
}

// Trip loudly if the provider touches the network: a seeded prompt MUST be a pure
// cache hit. We install this BEFORE importing the provider so any fetch from the
// generate() path (submit/poll/download) is caught.
globalThis.fetch = (input) => fail(`provider attempted a network fetch on a cache hit: ${String(input)}`);

const { meshyAssetProvider } = await tsImport(PROVIDER_PATH, import.meta.url);

const result = await meshyAssetProvider.generate({
  id: "t",
  label: "mug",
  meshyPrompt: "a small ceramic mug",
  approxSize: [0.1, 0.12, 0.1],
  position: [0, 0, 0],
  rotationYDeg: 0,
});

if (!result || typeof result.glbUrl !== "string" || result.glbUrl.length === 0) {
  fail(`generate() returned no glbUrl: ${JSON.stringify(result)}`);
}
const { glbUrl } = result;
if (!glbUrl.startsWith(CACHE_ROOT)) {
  fail(`glbUrl is not under the cache dir ${CACHE_ROOT}: ${glbUrl}`);
}
if (!glbUrl.endsWith(".glb")) {
  fail(`glbUrl is not a .glb path: ${glbUrl}`);
}
if (!existsSync(glbUrl)) {
  fail(`glbUrl does not point to an existing file: ${glbUrl}`);
}

process.stdout.write(`PASS: cache hit served ${glbUrl} with zero network\n`);
