#!/usr/bin/env node
// Critic render smoke — prove the amend loop's VISION render path is trustworthy:
// the headless page NORMALIZES each GLB to its approxSize, and we capture the scene
// from MULTIPLE critic angles (the two bugs this change fixes).
//
// Feeds the committed scripts/.assets/tiny-box.glb (the gitignored public/sample-assets/
// GLBs aren't present in a fresh checkout) through captureViews(scene, criticCameras(room)),
// so it spends NO Meshy credits and makes NO LLM calls. Run:
//   node scripts/critic-render-smoke.mjs
//
// Asserts:
//   1. criticCameras(room) yields 3 framing angles named front / left34 / right34.
//   2. captureViews returns 3 non-blank PNGs of the approxSize-normalized model.
//   3. A 2x approxSize fills strictly more of the frame — proving normalization bites
//      (without it, every box renders at the GLB's native size regardless of approxSize).
// Exits non-zero on any failure.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const GLB = join(SCRIPT_DIR, ".assets", "tiny-box.glb");

// criticCameras imports only a TYPE, so it loads via a plain .ts URL; captureViews and
// launchBrowser are value exports of .ts modules (Node strips the types on the fly).
const { captureViews } = await import(new URL("../src/render/multiangle/index.ts", import.meta.url).href);
const { criticCameras } = await import(new URL("../src/render/criticCameras.ts", import.meta.url).href);
const { launchBrowser } = await import(new URL("../src/render/headless.ts", import.meta.url).href);

const room = { width: 6, depth: 6, height: 3 };

// 1. criticCameras returns the 3 expected framing angles, each with a look-at target.
const cameras = criticCameras(room);
assertEqual(cameras.length, 3, "criticCameras returns 3 cameras");
assertEqual(cameras.map((c) => c.name).join(","), "front,left34,right34", "camera names");
for (const c of cameras) {
  if (!c.target) throw new Error(`camera "${c.name}" is missing a target`);
}

// A single GLB on the CENTER convention (position.y = half the bbox so it rests on y=0),
// carrying approxSize so the render page runs the normalization path.
const sceneWith = (size) => ({
  room,
  objects: [{ glbUrl: GLB, position: [0, size[1] / 2, 0], rotationYDeg: 0, scale: 1, approxSize: size }],
});

const browser = await launchBrowser();
try {
  // 2. Three non-blank angles of the approxSize-normalized model.
  console.log("Capturing 3 critic angles of the approxSize-normalized GLB...\n");
  const shots = await captureViews(sceneWith([1.5, 1.5, 1.5]), cameras, { browser });
  assertEqual(shots.length, 3, "captureViews returns one shot per camera");
  for (const s of shots) {
    const { width, height } = parsePngHeader(s.png);
    if (width !== 1024 || height !== 768) throw new Error(`view "${s.name}": unexpected PNG dims ${width}x${height}`);
    if (s.png.length < 4000) throw new Error(`view "${s.name}": PNG suspiciously small (${s.png.length} B) — likely blank`);
    if (s.stats.nonBackgroundFraction < 0.02) throw new Error(`view "${s.name}": looks blank`);
  }

  // 3. Normalization actually drives the rendered size: a 2x bbox fills strictly more frame.
  const big = await captureViews(sceneWith([3.0, 3.0, 3.0]), [cameras[0]], { browser });
  const frontSmall = shots.find((s) => s.name === "front");
  if (!(big[0].stats.nonBackgroundFraction > frontSmall.stats.nonBackgroundFraction)) {
    throw new Error(
      `approxSize did not change the render: front nonBg ${pct(frontSmall)} vs 2x ${pct(big[0])}`,
    );
  }
  console.log(`  OK approxSize drives scale: front ${pct(frontSmall)} -> 2x ${pct(big[0])}\n`);

  printTable([...shots, { name: "front@2x", ...big[0] }]);
  console.log("\n  PASS — 3 non-blank critic angles + approxSize normalization verified");
} finally {
  await browser.close();
}

function pct(shot) {
  return `${(shot.stats.nonBackgroundFraction * 100).toFixed(1)}%`;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
  console.log(`  OK ${label} (= ${actual})`);
}

// Minimal PNG header parser: validates the signature and reads width/height from IHDR.
function parsePngHeader(buf) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i++) {
    if (buf[i] !== signature[i]) throw new Error("not a PNG (bad signature)");
  }
  if (buf.toString("ascii", 12, 16) !== "IHDR") throw new Error("not a PNG (missing IHDR)");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function printTable(shots) {
  const cols = ["view", "distinctColors", "nonBackgroundFraction"];
  const rows = shots.map((s) => [s.name, String(s.stats.distinctColors), pct(s)]);
  const widths = cols.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c].length)));
  const fmt = (cells) => cells.map((v, c) => (c === 0 ? v.padEnd(widths[c]) : v.padStart(widths[c]))).join("  ");
  console.log(fmt(cols));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(fmt(r));
}
