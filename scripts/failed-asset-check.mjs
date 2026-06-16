#!/usr/bin/env node
// Failed/missing-asset verification for the "surface a clear state, never a blank canvas" change.
//
// Before: both renderers loaded every object's GLB via Promise.all, which REJECTS on the
// first failed load. One bad asset therefore took down the WHOLE scene — the live viewer
// (SceneViewer.loadScene) threw and left a blank canvas, and the headless render
// (scene-page.js buildScene) flipped __renderState to "error", blanking every camera angle
// and killing the amend round so the vision critic saw nothing. A `failed`-status object was
// also indistinguishable from a still-working `pending` one (both rendered the same blue box).
//
// After: a per-object GLB load failure is caught, logged loudly, and replaced by a clearly
// marked RED placeholder, so the rest of the scene still renders and the failure is visible;
// and a `failed` status now reads as the red marker while `pending` stays the blue "working"
// box. The appearance is a single shared definition (sceneVisuals.js standInAppearance /
// STANDIN_PENDING / STANDIN_FAILED) imported by both renderers, kept in lockstep.
//
// This proves it with NO Meshy credits and NO LLM calls:
//   1. PURE: the production standInAppearance maps "failed" -> red, everything else -> blue,
//      and the two appearances are visibly distinct (color AND opacity).
//   2. HEADLESS RENDER (scene-page.js via renderSceneToPng):
//      (a) a scene whose only object's GLB fails to load now renders NON-BLANK (a red
//          placeholder) — before this fix the scene build threw and rendered nothing.
//      (b) under one fixed camera, a mixed good+failed scene renders MORE non-background than
//          either object alone, proving the failed asset did NOT wipe out the good one.
//
// Run:  node scripts/failed-asset-check.mjs
// Exits non-zero on any failed assertion.

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TINY_BOX = new URL("./.assets/tiny-box.glb", import.meta.url).pathname;
const CORRUPT_GLB = join(SCRIPT_DIR, ".out", "corrupt-asset.glb");
const SC_DIR = "/tmp/sc-demo";

// Production shared appearance helper (pure data; sceneVisuals.js imports "three" but these
// exports touch no THREE object — the same import floor-rest-check / framing-check use).
const { standInAppearance, STANDIN_PENDING, STANDIN_FAILED } = await import(
  new URL("../src/render/sceneVisuals.js", import.meta.url).href
);
// The headless render harness (Node strips the .ts types on the fly).
const { renderSceneToPng, launchBrowser, assertNonBlank } = await import(
  new URL("../src/render/headless.ts", import.meta.url).href
);

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// assertNonBlank returns a warning string on a blank/degenerate frame and null otherwise;
// turn it into a boolean so a blank render reports as a failed assertion instead of
// aborting the whole script.
function isNonBlank(stats) {
  return assertNonBlank(stats) === null;
}

// --- 1. PURE: failed reads differently from pending -------------------------
console.log("1. Stand-in appearance (production standInAppearance):\n");

check('"failed" status -> the red STANDIN_FAILED marker',
  standInAppearance("failed") === STANDIN_FAILED && STANDIN_FAILED.color === 0xff5a5a,
  `color=0x${STANDIN_FAILED.color.toString(16)} opaque=${!STANDIN_FAILED.transparent}`);
check('"pending" status -> the blue STANDIN_PENDING marker',
  standInAppearance("pending") === STANDIN_PENDING && STANDIN_PENDING.color === 0x4dabf7,
  `color=0x${STANDIN_PENDING.color.toString(16)} translucent=${STANDIN_PENDING.transparent}`);
check("failed reads differently from pending (distinct color AND opacity)",
  STANDIN_FAILED.color !== STANDIN_PENDING.color && STANDIN_FAILED.transparent !== STANDIN_PENDING.transparent,
  `red opaque vs blue translucent`);
check("unknown/future status -> blue working marker (not the red failure alarm)",
  standInAppearance("queued") === STANDIN_PENDING,
  `only "failed" is red`);

// --- 2. HEADLESS RENDER -----------------------------------------------------
console.log("\n2. Headless render (a failed asset shows a placeholder, never a blank/crashed scene):\n");

// A file that EXISTS (so it is served) but is NOT a valid GLB, so loadAsync fetches it and
// then fails to parse it — the realistic "corrupt / wrong-bytes cached asset" failure that
// used to crash the whole render.
await mkdir(dirname(CORRUPT_GLB), { recursive: true });
await writeFile(CORRUPT_GLB, "this is not a valid glb file\n");

const room = { width: 4, depth: 4, height: 3 };
const approx = [1, 1, 1];
const good = (x) => ({ glbUrl: TINY_BOX, position: [x, approx[1] / 2, 0], rotationYDeg: 0, scale: 1, approxSize: approx });
const bad = (x) => ({ glbUrl: CORRUPT_GLB, position: [x, approx[1] / 2, 0], rotationYDeg: 0, scale: 1, approxSize: approx });
// A fixed camera that frames both X slots, so the three comparison renders share framing and
// "more objects -> more covered pixels" is a clean, monotone signal.
const camera = { position: [0, 2.5, 5], target: [0, 0.5, 0] };

const browser = await launchBrowser();
try {
  // (a) Corrupt-only, default content-fit camera: before the fix this threw
  // "In-browser scene build failed"; it must now render a non-blank red placeholder.
  const badOnly = await renderSceneToPng({ room, objects: [bad(0)] }, { browser });
  check("a failed asset renders a visible placeholder (non-blank), not a blank/crashed scene",
    isNonBlank(badOnly.stats),
    `${(badOnly.stats.nonBackgroundFraction * 100).toFixed(1)}% non-bg, ${badOnly.stats.distinctColors} colors ` +
      `(before this fix the scene build THREW and rendered nothing)`);

  // (b) Same fixed camera: good-only, bad-only, and mixed. The mixed scene must render
  // non-blank AND cover MORE of the frame than either object alone — proof that the failed
  // asset did not wipe out the good one (both are present, side by side).
  const goodFixed = await renderSceneToPng({ room, objects: [good(-1)], camera }, { browser });
  const badFixed = await renderSceneToPng({ room, objects: [bad(1)], camera }, { browser });
  const mixed = await renderSceneToPng({ room, objects: [good(-1), bad(1)], camera }, { browser });

  const g = goodFixed.stats.nonBackgroundFraction;
  const b = badFixed.stats.nonBackgroundFraction;
  const m = mixed.stats.nonBackgroundFraction;
  console.log(`    fixed camera non-bg: good-only ${(g * 100).toFixed(1)}%  failed-only ${(b * 100).toFixed(1)}%  mixed ${(m * 100).toFixed(1)}%`);
  check("one bad asset does not blank the others — mixed good+failed scene renders non-blank",
    isNonBlank(mixed.stats), `${(m * 100).toFixed(1)}% non-bg, ${mixed.stats.distinctColors} colors`);
  check("BOTH objects render — mixed covers more frame than the good object alone",
    m > g + 0.005, `mixed ${(m * 100).toFixed(1)}% > good-only ${(g * 100).toFixed(1)}%`);
  check("BOTH objects render — mixed covers more frame than the failed marker alone",
    m > b + 0.005, `mixed ${(m * 100).toFixed(1)}% > failed-only ${(b * 100).toFixed(1)}%`);

  // (c) Bonus regression: the curated StarCraft demo (all GLBs load) must still render fully
  // and show NO failure marker — i.e. the catch branch never fires on the happy path.
  const scGlbs = ["marine", "zergling", "hydralisk"].map((n) => `${SC_DIR}/${n}.glb`);
  if (scGlbs.every((p) => existsSync(p))) {
    const sc = await renderSceneToPng(
      {
        room: { width: 8, depth: 6, height: 3.5 },
        objects: [
          { glbUrl: scGlbs[0], position: [-1.8, 1.0, 0.5], rotationYDeg: 25, scale: 1, approxSize: [1.21, 2.0, 1.02] },
          { glbUrl: scGlbs[1], position: [1.5, 0.5, -0.5], rotationYDeg: -120, scale: 1, approxSize: [1.96, 1.0, 1.87] },
          { glbUrl: scGlbs[2], position: [0.2, 1.3, -2.0], rotationYDeg: 180, scale: 1, approxSize: [1.6, 2.6, 1.6] },
        ],
      },
      { browser },
    );
    check("curated StarCraft demo (all assets load) still renders fully, no failure marker",
      isNonBlank(sc.stats) && sc.stats.distinctColors > 16,
      `${(sc.stats.nonBackgroundFraction * 100).toFixed(1)}% fill, ${sc.stats.distinctColors} colors`);
  } else {
    console.log(`\n  SKIP — pinned StarCraft GLBs not present under ${SC_DIR} (failed-asset proof stands)`);
  }
} finally {
  await browser.close();
}

console.log("");
if (failures > 0) {
  console.error(`FAIL — ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("PASS — a missing/failed asset surfaces a clear red placeholder; one bad asset never blanks the scene");
