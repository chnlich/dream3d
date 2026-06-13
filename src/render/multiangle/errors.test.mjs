#!/usr/bin/env node
// Validation tests for captureViews. These exercise the argument-error paths
// only, which throw before any browser launch — so this runs fast and needs no
// GPU/WebGL. Mirrors scripts/render-smoke.mjs's loader (Node strips TS types, so
// the .ts module imports directly). Run:
//   node src/render/multiangle/errors.test.mjs
// Exits non-zero if any assertion fails.

const { captureViews } = await import(new URL("./index.ts", import.meta.url).href);

// A trivial scene; these cases never render, so its contents are irrelevant.
const scene = { room: { width: 4, depth: 4, height: 2.6 }, objects: [] };

let failures = 0;

async function expectThrow(label, cameras, mustInclude) {
  try {
    await captureViews(scene, cameras);
    console.log(`FAIL  ${label}: expected an Error, none thrown`);
    failures++;
  } catch (error) {
    const msg = String(error?.message ?? error);
    const ok = mustInclude.every((needle) => msg.includes(needle));
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${msg}`);
    if (!ok) failures++;
  }
}

// A camera with NEITHER target nor direction throws, naming the view.
await expectThrow(
  "neither target nor direction",
  [{ name: "bad_neither", position: [1, 1, 1] }],
  ["bad_neither", "exactly one of target/direction"],
);

// A camera with BOTH target and direction throws, naming the view.
await expectThrow(
  "both target and direction",
  [{ name: "bad_both", position: [1, 1, 1], target: [0, 0, 0], direction: [0, 0, -1] }],
  ["bad_both", "exactly one of target/direction"],
);

// Empty camera list throws.
await expectThrow("empty cameras", [], ["at least one camera"]);

// Duplicate camera names throw (output filenames must be unique).
await expectThrow(
  "duplicate names",
  [
    { name: "dup", position: [1, 1, 1], target: [0, 0, 0] },
    { name: "dup", position: [2, 2, 2], target: [0, 0, 0] },
  ],
  ["duplicate camera name", "dup"],
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll captureViews validation tests passed.");
