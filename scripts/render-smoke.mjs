#!/usr/bin/env node
// Self-contained proof that we can render a three.js scene to a PNG, server-side,
// in headless Chromium on this host. Run with:  node scripts/render-smoke.mjs
//
// It renders a hardcoded scene (a room + a few primitives), writes the PNG to
// scripts/.out/render-smoke.png, independently verifies the image is a real
// non-blank render, and prints the path. Exits non-zero on any failure.
//
// Host setup (Playwright + Chromium + WebGL libraries) is documented in
// docs/headless-render.md. The render logic itself lives in src/render/headless.ts.

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(SCRIPT_DIR, ".out", "render-smoke.png");

// Node 22 strips TypeScript types on the fly, so a .mjs can import the .ts harness directly.
const { renderSceneToPng, assertNonBlank } = await import(new URL("../src/render/headless.ts", import.meta.url).href);

// A minimal hardcoded scene: a 4 x 4 x 2.6 room with three primitives on the floor.
const scene = {
  room: { width: 4, depth: 4, height: 2.6 },
  objects: [
    { primitive: "box", position: [0, 0.5, 0], rotationYDeg: 20, scale: 1.0, color: 0xff6b6b },
    { primitive: "cylinder", position: [1.3, 0.6, -0.6], rotationYDeg: 0, scale: 1.2, color: 0x4dabf7 },
    { primitive: "box", position: [-1.2, 0.4, 0.9], rotationYDeg: -15, scale: 0.8, color: 0x51cf66 },
  ],
};

console.log("Rendering hardcoded smoke scene in headless Chromium (software WebGL)...");
const { png, stats, durationMs } = await renderSceneToPng(scene, { width: 1024, height: 768 });

await mkdir(dirname(OUT_PATH), { recursive: true });
await writeFile(OUT_PATH, png);

// Independent verification (in addition to the in-page pixel stats):
//  - parse the PNG header to confirm a valid image of the expected dimensions
//  - confirm the file is non-trivially sized
const header = parsePngHeader(png);
assertNonBlank(stats);
if (png.length < 4000) {
  throw new Error(`PNG is suspiciously small (${png.length} bytes) — likely blank`);
}
if (header.width !== 1024 || header.height !== 768) {
  throw new Error(`Unexpected PNG dimensions: ${header.width}x${header.height}`);
}

console.log("");
console.log("  PASS — non-blank PNG rendered");
console.log(`  path             : ${OUT_PATH}`);
console.log(`  png size         : ${(png.length / 1024).toFixed(1)} KiB`);
console.log(`  dimensions       : ${header.width}x${header.height} (from PNG header)`);
console.log(`  render time      : ${durationMs.toFixed(0)} ms (incl. browser launch)`);
console.log(`  distinct colors  : ${stats.distinctColors}`);
console.log(`  non-bg fraction  : ${(stats.nonBackgroundFraction * 100).toFixed(1)}%`);
console.log(`  luminance stddev : ${stats.luminanceStdDev.toFixed(1)}`);

// Minimal dependency-free PNG header parser: validates the signature and reads
// width/height from the IHDR chunk.
function parsePngHeader(buf) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i++) {
    if (buf[i] !== signature[i]) {
      throw new Error("not a PNG (bad signature)");
    }
  }
  if (buf.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("not a PNG (missing IHDR)");
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
