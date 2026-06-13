#!/usr/bin/env node
// MOCK-mode pipeline smoke — prove the amend loop drives the NEW multi-view critic
// signatures end to end with NO LLM and NO Meshy calls.
//
// Runs generate(prompt, 2, "mock") and asserts the response carries amendRounds + 1
// passes (draft + 2 amend rounds) whose scenes CHANGE per round — i.e. the loop runs,
// the updated VisionCritic.review({ scene, views }) signature is wired in (mock passes
// views: []), and fix() advances the scene each round. Run:
//   node scripts/pipeline-mock-smoke.mjs
//
// The orchestrator uses extensionless relative TS imports (Vite resolves these at
// runtime); under plain Node we register a tiny resolve hook so the same source runs
// unbundled. Exits non-zero on any failed assertion.

import { register } from "node:module";

register("./ts-resolve-hook.mjs", import.meta.url);

const { generate } = await import(new URL("../src/pipeline/orchestrator.ts", import.meta.url).href);

const AMEND_ROUNDS = 2;
const PROMPT = "a cozy living room with a sofa, a coffee table and a lamp";

console.log(`Running MOCK generate("${PROMPT}", amendRounds=${AMEND_ROUNDS})...\n`);
const res = await generate(PROMPT, AMEND_ROUNDS, "mock");

assertEqual(res.passes.length, AMEND_ROUNDS + 1, "passes.length === amendRounds + 1");

// Every amend round must change the scene vs the previous pass (the loop applied a fix).
let changedRounds = 0;
for (let i = 1; i < res.passes.length; i++) {
  const changed = JSON.stringify(res.passes[i - 1].sceneState) !== JSON.stringify(res.passes[i].sceneState);
  console.log(`  round ${i}: scene ${changed ? "CHANGED" : "UNCHANGED"} vs pass ${i - 1}`);
  if (changed) changedRounds++;
}
if (changedRounds < AMEND_ROUNDS) {
  throw new Error(`expected ${AMEND_ROUNDS} changed rounds, got ${changedRounds}`);
}

// Show WHAT changed: the mock critic rotates the worst-facing object each round.
console.log("");
for (let i = 0; i < res.passes.length; i++) {
  const yaws = res.passes[i].sceneState.objects.map((o) => `${o.id}=${o.transform.rotationYDeg}°`).join("  ");
  console.log(`  pass ${i} yaws: ${yaws}`);
}

console.log(`\n  PASS — mock amend loop ran ${AMEND_ROUNDS} rounds with per-round scene changes`);

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
  console.log(`  OK ${label} (= ${actual})`);
}
