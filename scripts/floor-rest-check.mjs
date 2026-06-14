#!/usr/bin/env node
// Floor-rest verification for the approxSize-slot seating fix.
//
// Both renderers (src/viewer/SceneViewer.ts + src/render/scene-page.js) fit each
// model to its approxSize "slot", then place a pivot at transform.position (the
// slot CENTER, y = approxSize[1]/2 for a resting object). The OLD code centered the
// fitted bounding box on the pivot in Y, so any model shorter than approxSize[1] —
// i.e. whenever Y is not the fit-dominant axis, which is most flat/wide objects —
// floated by half the height gap. The fix seats the model's BASE on the slot floor
// in Y via the shared slotSeatOffset() (src/render/sceneVisuals.js), so the base
// lands on y=0 regardless of the fitted height.
//
// A second, independent way to mis-seat a model is SCALE: the vision critic's `resize`
// fix multiplies transform.scale, but the renderers scale the model about the pivot at
// transform.position, so the base only stays on the floor if position.y tracks the
// resting center height approxSize[1]·scale/2 (= geometryCheck.restY, which layout.ts
// emits at scale 1). The old fix() left position.y at its scale-1 value, so any resized
// object sank (scale>1) or floated (scale<1) by (1-scaleFactor)·approxSize[1]/2 — in both
// the live viewer and the headless critic's own render. fix() now re-seats it.
//
// This script proves both fixes, with NO Meshy credits:
//   1. PURE MATH — drive the production slotSeatOffset() over representative fitted
//      bounding boxes (incl. flat models the old code floated) and assert the world
//      base lands on the floor (and the footprint stays centered).
//   2. REAL ASSET — load a cached Meshy GLB in headless Chromium, fit it to a neutral
//      slot, and measure the world base under the OLD center-seat vs the NEW base-seat.
//      Asserts the new base rests on the floor (at scale 1 AND non-unit scales); reports
//      the old float distance.
//   3. PRODUCTION fix() — drive the real resize fix (src/pipeline/fix.ts) and assert the
//      resulting position.y rests the model under the render equation, for an enlarge AND
//      a shrink; show how far the OLD fix() (stale position.y) sank / floated it.
//
// Run:  node scripts/floor-rest-check.mjs
// Exits non-zero on any failed assertion.

import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { readFile, realpath, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { register } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = dirname(SCRIPT_DIR);
const RENDER_DIR = join(REPO_DIR, "src", "render");
const VENDOR_DIR = join(RENDER_DIR, "vendor", "three");
const SCENE_VISUALS_PATH = join(RENDER_DIR, "sceneVisuals.js");

const EPS = 1e-6; // a base this close to y=0 is "on the floor"

// slotSeatOffset is the production seating math, shared by both renderers.
const { slotSeatOffset } = await import(new URL("../src/render/sceneVisuals.js", import.meta.url).href);

// fix() is the production review-fix applier: a `resize` fix must re-seat the object
// on the floor at the new scale (src/pipeline/fix.ts). Register the TS resolve hook so
// plain `node` can import the unbundled .ts source (same pattern as pipeline-mock-smoke.mjs).
register("./ts-resolve-hook.mjs", import.meta.url);
const { fix } = await import(new URL("../src/pipeline/fix.ts", import.meta.url).href);

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// --- 1. PURE MATH ----------------------------------------------------------
//
// Model the full seating pipeline for a floor-resting object at scale 1: a fitted
// bbox [min, max] (model-local, node.position = 0) seated by slotSeatOffset, then a
// pivot at transform.position = [px, approxY/2, pz]. World base = pivotY + localMinY.
console.log("1. Pure-math seating (production slotSeatOffset):\n");

function worldRest(min, max, approxSize, pivotXZ) {
  const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const approxY = approxSize[1];
  const off = slotSeatOffset(min, center, approxY);
  const pivotY = approxY / 2; // layout.ts: resting center for scale 1
  // NEW (base-seat) vs OLD (center-seat on all three axes).
  const newBaseY = pivotY + (min[1] + off[1]);
  const oldBaseY = pivotY + (min[1] - center[1]);
  // Footprint center in world after the X/Z offset, plus pivot translation.
  const footX = pivotXZ[0] + (center[0] + off[0]);
  const footZ = pivotXZ[1] + (center[2] + off[2]);
  return { newBaseY, oldBaseY, footX, footZ, fittedHeight: max[1] - min[1] };
}

// label, fitted bbox [min,max], approxSize, planned footprint [px,pz]
const cases = [
  // Y is the fit-dominant axis: fitted height == approxY. Old already rested.
  ["tall figure (Y-dominant)", [-0.6, 0, -0.5], [0.6, 2.0, 0.5], [1.21, 2.0, 1.02], [-1.8, 0.5]],
  // Flat/wide: fitted height << approxY. Old FLOATED; new must rest.
  ["wide rug (Y not dominant)", [-1.0, 0, -0.7], [1.0, 0.06, 0.7], [2.0, 0.5, 1.4], [0, 0]],
  // Low table: fitted height noticeably under approxY. Old floated.
  ["coffee table (low)", [-0.6, 0, -0.3], [0.6, 0.35, 0.3], [1.2, 0.45, 0.6], [2.4, 0.1]],
  // Crouched creature, asymmetric raw center to also exercise footprint centering.
  ["crouched beast (off-center bbox)", [0.2, 0, 0.4], [1.8, 0.9, 2.0], [1.96, 1.0, 1.87], [1.5, -0.5]],
];

for (const [label, min, max, approxSize, pivotXZ] of cases) {
  const r = worldRest(min, max, approxSize, pivotXZ);
  const floated = r.oldBaseY > EPS;
  check(
    `${label}: new base on floor`,
    Math.abs(r.newBaseY) < EPS && Math.abs(r.footX - pivotXZ[0]) < EPS && Math.abs(r.footZ - pivotXZ[1]) < EPS,
    `fittedH=${r.fittedHeight.toFixed(2)} approxY=${approxSize[1].toFixed(2)} ` +
      `newBaseY=${r.newBaseY.toFixed(4)} oldBaseY=${r.oldBaseY.toFixed(4)}` +
      (floated ? ` (old FLOATED +${r.oldBaseY.toFixed(3)}m)` : " (old also rested)"),
  );
}

// The fix must actually matter: at least one representative case floated before.
check(
  "fix is load-bearing (>=1 case floated under old center-seat)",
  cases.some(([, min, max, approxSize, pivotXZ]) => worldRest(min, max, approxSize, pivotXZ).oldBaseY > EPS),
);

// --- 2. REAL ASSET ---------------------------------------------------------
//
// Load a real cached Meshy GLB in headless Chromium, fit it to a neutral [1,1,1]
// slot, and measure the world base under the OLD center-seat vs the NEW base-seat.
console.log("\n2. Real-asset seating (cached Meshy GLB in headless Chromium):\n");

const glbPath = await firstResolvableGlb();
if (!glbPath) {
  console.log("  SKIP — no resolvable cached GLB under ~/.cache/dream3d/assets (pure-math proof stands)");
} else {
  const APPROX = [1, 1, 1]; // a neutral slot: a flatter-than-cube mesh is Y-non-dominant -> old floats
  const measured = await measureRealAsset(glbPath, APPROX);
  console.log(`  asset            : ${glbPath}`);
  console.log(`  fitted height    : ${measured.fittedHeight.toFixed(4)} m (slot approxY = ${APPROX[1]})`);
  console.log(`  OLD world base.y : ${measured.oldWorldBaseY.toFixed(4)} m`);
  console.log(`  NEW world base.y : ${measured.newWorldBaseY.toFixed(4)} m`);
  check("real asset: new base rests on floor", Math.abs(measured.newWorldBaseY) < 1e-4, `${measured.newWorldBaseY.toFixed(5)} m`);
  if (measured.fittedHeight < APPROX[1] - 1e-3) {
    check(
      "real asset: old center-seat floated (bug reproduced)",
      measured.oldWorldBaseY > 1e-3,
      `floated +${measured.oldWorldBaseY.toFixed(3)} m`,
    );
  } else {
    console.log(`  note: this asset is ~Y-dominant in a unit slot, so the old code also rested it; see pure-math cases for the float.`);
  }

  // Non-unit scale on the REAL mesh: under the production convention
  // position.y = approxY*scale/2 (layout.ts / geometryCheck.restY / the new fix.ts), the
  // pivot scales the model — base at pivot-local localBaseY — about position.y, so the world
  // base is position.y + scale*localBaseY. Prove a real Meshy mesh rests at scale != 1, and
  // show how far the pre-fix stale position.y (left at the scale-1 value) sank / floated it.
  for (const scale of [1.5, 0.5]) {
    const restingY = (APPROX[1] * scale) / 2; // fix.ts writes this on resize
    const worldBase = restingY + scale * measured.localBaseY;
    const staleBase = APPROX[1] / 2 + scale * measured.localBaseY; // pre-fix position.y
    check(
      `real asset: rests at scale ${scale}`,
      Math.abs(worldBase) < 1e-4,
      `worldBase=${worldBase.toFixed(5)} m (pre-fix stale position.y -> ` +
        `${staleBase >= 0 ? "+" : ""}${staleBase.toFixed(3)} m ${staleBase > 0 ? "FLOAT" : "SINK"})`,
    );
  }
}

// ---------------------------------------------------------------------------

// --- 3. PRODUCTION fix(): a resize re-seats on the floor -------------------
//
// The data-side half of "rest at any scale": the vision critic's `resize` fix multiplies
// transform.scale; fix() must also re-seat the CENTER so position.y stays at the resting
// height approxY*scale/2. Drive the REAL fix() (src/pipeline/fix.ts) over an object resting
// at scale 1 and assert the result rests under the render equation
// worldBase = position.y - scale*approxY/2, for an enlarge AND a shrink. The OLD fix() left
// position.y untouched, so the SAME object sank / floated.
console.log("\n3. Production fix() resize re-seats on the floor (src/pipeline/fix.ts):\n");

const APPROX_Y = 1.8;
for (const factor of [1.5, 0.4]) {
  const before = restingSceneAtScale1(APPROX_Y);
  const after = fix(before, [resizeIssue("obj", factor)]);
  const o = after.objects[0];
  const renderedBase = o.transform.position[1] - o.transform.scale * (APPROX_Y / 2);
  // What the OLD fix() produced: same scale, position.y left at the scale-1 resting value.
  const staleBase = APPROX_Y / 2 - o.transform.scale * (APPROX_Y / 2);
  check(
    `resize x${factor}: object rests after fix()`,
    Math.abs(renderedBase) < EPS && Math.abs(o.transform.scale - factor) < EPS,
    `scale=${o.transform.scale.toFixed(2)} position.y=${o.transform.position[1].toFixed(3)} ` +
      `renderedBase=${renderedBase.toFixed(4)} (old fix() -> ` +
      `${staleBase >= 0 ? "+" : ""}${staleBase.toFixed(3)} m ${staleBase > 0 ? "FLOAT" : "SINK"})`,
  );
  check(
    `resize x${factor}: only scale + center-Y change`,
    o.transform.position[0] === 1.5 && o.transform.position[2] === -0.5 && o.transform.rotationYDeg === 30,
    `pos=[${o.transform.position.map((n) => n.toFixed(2)).join(", ")}] yaw=${o.transform.rotationYDeg}`,
  );
}

// The fix must matter: under the OLD fix() an enlarge x1.5 left the base materially off the floor.
check(
  "resize fix is load-bearing (pre-fix base != 0)",
  Math.abs(APPROX_Y / 2 - 1.5 * (APPROX_Y / 2)) > 0.1,
  `enlarge x1.5 sank ${(APPROX_Y / 2 - 1.5 * (APPROX_Y / 2)).toFixed(3)} m under old fix()`,
);

// ---------------------------------------------------------------------------

console.log("");
if (failures > 0) {
  console.error(`FAIL — ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("PASS — models seat their base on the floor at any scale (short fitted height AND resize)");

// ---------------------------------------------------------------------------
// Real-asset probe: a minimal three.js page that loads the GLB, fits it, and
// reports the world base.y for the old (center-seat) vs new (slotSeatOffset) seating.
// No WebGL render is needed — Box3.setFromObject reads geometry directly.
// ---------------------------------------------------------------------------

async function measureRealAsset(modelPath, approxSize) {
  const browser = await launchBrowser();
  const server = await startProbeServer(modelPath);
  let page = null;
  try {
    page = await browser.newPage();
    const consoleLines = [];
    page.on("console", (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}`));
    await page.goto(server.origin, { waitUntil: "load" });
    await page.waitForFunction(() => window.__result || window.__error, undefined, { timeout: 60_000 });
    const error = await page.evaluate(() => window.__error);
    if (error) {
      throw new Error(`probe page failed:\n${error}\n--- console ---\n${consoleLines.join("\n")}`);
    }
    return await page.evaluate(() => window.__result);
  } finally {
    if (page) await page.close();
    await server.close();
    await browser.close();
  }
}

function probeModule() {
  // Runs in the browser. Mirrors the production fit (one line, identical in both
  // renderers) and uses the SHARED slotSeatOffset for the new seating, so this
  // exercises the real seating math on a real mesh's three.js bounding box.
  return `
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { slotSeatOffset } from "/sceneVisuals.js";
const approx = window.__APPROX__;
try {
  const gltf = await new GLTFLoader().loadAsync("/model.glb");
  const node = gltf.scene;
  node.updateMatrixWorld(true);
  const pre = new THREE.Box3().setFromObject(node).getSize(new THREE.Vector3());
  const fit = 1 / Math.max(pre.x / approx[0], pre.y / approx[1], pre.z / approx[2]);
  node.scale.multiplyScalar(fit);
  node.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(node);
  const c = box.getCenter(new THREE.Vector3());
  const off = slotSeatOffset([box.min.x, box.min.y, box.min.z], [c.x, c.y, c.z], approx[1]);
  const pivotY = approx[1] / 2;
  // localBaseY is the model's base in PIVOT-local space (after fit + seat). The pivot
  // scales the model about its origin, so the world base is pivot.position.y + scale*localBaseY;
  // slotSeatOffset makes this -approx[1]/2, which is what lets a non-unit scale rest (section 2).
  window.__result = {
    fittedHeight: box.max.y - box.min.y,
    localBaseY: box.min.y + off[1],
    newWorldBaseY: pivotY + (box.min.y + off[1]),
    oldWorldBaseY: pivotY + (box.min.y - c.y),
  };
} catch (e) {
  window.__error = (e && e.stack) || String(e);
}
`;
}

async function startProbeServer(modelPath) {
  const importmap = JSON.stringify({
    imports: { three: "/vendor/three/three.module.js", "three/addons/": "/vendor/three/addons/" },
  });
  const html = `<!doctype html><html><head><meta charset="utf-8" />
<script type="importmap">${importmap}</script></head>
<body><script>window.__APPROX__=[1,1,1];</script>
<script type="module">${probeModule()}</script></body></html>`;

  const port = await getFreePort();
  const server = createServer(async (req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    try {
      if (url === "/") return sendBuf(res, 200, "text/html; charset=utf-8", Buffer.from(html));
      if (url === "/sceneVisuals.js") return sendBuf(res, 200, "text/javascript; charset=utf-8", await readFile(SCENE_VISUALS_PATH));
      if (url === "/model.glb") return sendBuf(res, 200, "model/gltf-binary", await readFile(modelPath));
      if (url.startsWith("/vendor/three/")) {
        const filePath = join(VENDOR_DIR, url.slice("/vendor/three/".length));
        if (!filePath.startsWith(VENDOR_DIR)) return sendBuf(res, 403, "text/plain", Buffer.from("forbidden"));
        const ctype = filePath.endsWith(".js") ? "text/javascript; charset=utf-8" : "application/octet-stream";
        return sendBuf(res, 200, ctype, await readFile(filePath));
      }
      return sendBuf(res, 404, "text/plain", Buffer.from("not found"));
    } catch (e) {
      sendBuf(res, 500, "text/plain", Buffer.from(`server error: ${e.message}`));
    }
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function sendBuf(res, status, contentType, body) {
  res.writeHead(status, { "content-type": contentType, "content-length": body.length });
  res.end(body);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

// Reuse the harness launcher (sets LD_LIBRARY_PATH + resolves Chromium for this host).
async function launchBrowser() {
  const headless = await import(new URL("../src/render/headless.ts", import.meta.url).href);
  return headless.launchBrowser();
}

// First cached GLB whose (possibly symlinked) target actually exists, preferring a
// flat asset (area-rug / coffee-table) so the old float is large and obvious.
async function firstResolvableGlb() {
  const dir = join(homedir(), ".cache", "dream3d", "assets");
  if (!existsSync(dir)) return null;
  const entries = (await readdir(dir)).filter((f) => f.endsWith(".glb"));
  const preferred = ["area-rug", "coffee-table", "desk", "bookshelf"];
  entries.sort((a, b) => rank(a, preferred) - rank(b, preferred));
  for (const name of entries) {
    let real;
    try {
      real = await realpath(join(dir, name));
    } catch (e) {
      console.log(`  (skip ${name}: dangling symlink — ${e.code ?? e.message})`); // logged, not swallowed
      continue;
    }
    if (existsSync(real) && (await stat(real)).size > 1000) return real; // skip tiny placeholder symlinks
  }
  return null;
}

function rank(name, preferred) {
  const i = preferred.findIndex((p) => name.startsWith(p));
  return i === -1 ? preferred.length : i;
}

// A minimal SceneState with one object resting on the floor at scale 1 — position is the
// CENTER, so its resting Y is approxY/2 (layout.ts's convention). rotationYDeg is non-zero
// so section 3 can assert the resize leaves yaw untouched.
function restingSceneAtScale1(approxY) {
  return {
    room: { width: 8, depth: 6, height: 4 },
    objects: [
      {
        id: "obj",
        label: "test object",
        meshyPrompt: "x",
        approxSize: [1, approxY, 1],
        transform: { position: [1.5, approxY / 2, -0.5], rotationYDeg: 30, scale: 1 },
        status: "ready",
      },
    ],
    pass: 0,
  };
}

// A vision-style resize ReviewIssue: scale by `factor` (>1 enlarge, <1 shrink).
function resizeIssue(objectId, factor) {
  return {
    objectId,
    kind: factor > 1 ? "too_small" : "too_big",
    severity: "medium",
    description: "resize",
    fix: { op: "resize", scaleFactor: factor },
    source: "vision",
  };
}
