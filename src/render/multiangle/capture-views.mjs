#!/usr/bin/env node
// Runnable CLI for the multi-angle capture module — co-located here (not in
// scripts/) to keep the feature self-contained.
//
// Renders the bundled demo scene + cameras (or caller-supplied JSON) to one PNG
// per camera plus a manifest.json, then prints a per-view table, the total
// wall-clock, and the written paths. Mirrors scripts/render-smoke.mjs: Node 22
// strips TypeScript types on the fly, so this .mjs imports the .ts module via a
// dynamic import of its URL. Run:
//   node src/render/multiangle/capture-views.mjs --out /tmp/mv-smoke
//   node src/render/multiangle/capture-views.mjs --scene s.json --cameras c.json --out dir
//
// Exits non-zero if any view fails (e.g. the non-blank assertion).

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// Same loader as scripts/render-smoke.mjs: import the .ts source directly.
const { captureViews } = await import(new URL("./index.ts", import.meta.url).href);

try {
  const args = parseArgs(process.argv.slice(2));
  const scenePath = args.scene ?? join(SCRIPT_DIR, "fixtures", "sc-demo.scene.json");
  const camerasPath = args.cameras ?? join(SCRIPT_DIR, "fixtures", "sc-demo.cameras.json");
  const outDir = args.out ?? (await mkdtemp(join(tmpdir(), "dream3d-multiangle-")));

  const scene = JSON.parse(await readFile(scenePath, "utf8"));
  const cameras = JSON.parse(await readFile(camerasPath, "utf8"));

  console.error(`Capturing ${cameras.length} view(s) of ${scene.objects.length} object(s)...`);
  console.error(`  scene  : ${resolve(scenePath)}`);
  console.error(`  cameras: ${resolve(camerasPath)}`);
  console.error(`  outDir : ${resolve(outDir)}`);
  console.error("");

  const startedAt = performance.now();
  const shots = await captureViews(scene, cameras, { outDir, width: args.width, height: args.height });
  const wallMs = performance.now() - startedAt;

  printTable(shots);
  console.log("");
  console.log(`total wall-clock : ${wallMs.toFixed(0)} ms for ${shots.length} view(s)`);
  console.log("written files:");
  for (const shot of shots) {
    console.log(`  ${join(resolve(outDir), `${shot.name}.png`)}`);
  }
  console.log(`  ${join(resolve(outDir), "manifest.json")}`);
} catch (error) {
  console.error(`\ncapture-views FAILED: ${error?.stack ?? error}`);
  process.exit(1);
}

// --- helpers ---------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--scene") out.scene = argv[++i];
    else if (arg === "--cameras") out.cameras = argv[++i];
    else if (arg === "--out") out.out = argv[++i];
    else if (arg === "--width") out.width = Number(argv[++i]);
    else if (arg === "--height") out.height = Number(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

// Print: view | renderMs | distinctColors | nonBackgroundFraction (aligned).
function printTable(shots) {
  const cols = ["view", "renderMs", "distinctColors", "nonBackgroundFraction"];
  const rows = shots.map((s) => [
    s.name,
    s.durationMs.toFixed(0),
    String(s.stats.distinctColors),
    `${(s.stats.nonBackgroundFraction * 100).toFixed(1)}%`,
  ]);
  const widths = cols.map((header, c) => Math.max(header.length, ...rows.map((r) => r[c].length)));
  // Left-align the label column, right-align the numeric columns.
  const fmt = (cells) => cells.map((v, c) => (c === 0 ? v.padEnd(widths[c]) : v.padStart(widths[c]))).join("  ");
  console.log(fmt(cols));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(fmt(r));
}
