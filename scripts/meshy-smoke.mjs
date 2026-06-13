#!/usr/bin/env node
// meshy-smoke.mjs — end-to-end smoke test for the Meshy text-to-3D PREVIEW flow.
//
// Verifies the API key + the full submit -> poll -> download flow against the LIVE API.
//
// Usage:
//   node scripts/meshy-smoke.mjs "your prompt"
//   node scripts/meshy-smoke.mjs               # defaults to "a small wooden stool"
//
// Reads the Meshy API key from config/local.json at the repo root (gitignored):
//   { "meshyApiKey": "msy_..." }
//
// NOTE: each run submits one real preview job and consumes ~20 Meshy credits.

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const CONFIG_PATH = join(REPO_ROOT, "config", "local.json");
const OUTPUT_DIR = join(SCRIPT_DIR, ".out");
const OUTPUT_PATH = join(OUTPUT_DIR, "smoke.glb");

const MESHY_BASE_URL = "https://api.meshy.ai";
const TEXT_TO_3D_PATH = "/openapi/v2/text-to-3d";

const POLL_INTERVAL_MS = 6000;
const TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_PROMPT = "a small wooden stool";

const CONFIG_HELP =
  `Create ${CONFIG_PATH} with this shape (it is gitignored — never commit it):\n` +
  `  { "meshyApiKey": "msy_..." }`;

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

async function submitPreview(apiKey, prompt) {
  const response = await fetch(`${MESHY_BASE_URL}${TEXT_TO_3D_PATH}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ mode: "preview", prompt, target_formats: ["glb"] }),
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

async function downloadGlb(url) {
  // model_urls.glb is a presigned CloudFront URL — send NO Authorization header.
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Meshy GLB download failed: HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error(`Meshy GLB download returned an empty payload from ${url}`);
  }
  return bytes;
}

function exitFailedTask(task) {
  const detail = task.task_error?.message ? `: ${task.task_error.message}` : "";
  console.error(`Meshy task ${task.id} ended with ${task.status}${detail}`);
  process.exit(1);
}

async function main() {
  const prompt = process.argv[2] ?? DEFAULT_PROMPT;
  const apiKey = await loadMeshyApiKey();

  console.log(`Submitting Meshy preview job for prompt: "${prompt}"`);
  const taskId = await submitPreview(apiKey, prompt);
  console.log(`Submitted. taskId=${taskId}`);

  const startedAt = Date.now();
  for (;;) {
    const task = await pollTask(apiKey, taskId);
    console.log(`status=${task.status} progress=${task.progress}`);

    if (task.status === "SUCCEEDED") {
      const glbUrl = task.model_urls?.glb;
      if (!glbUrl) {
        throw new Error(`Meshy task ${taskId} SUCCEEDED without model_urls.glb`);
      }
      const bytes = await downloadGlb(glbUrl);
      await mkdir(OUTPUT_DIR, { recursive: true });
      await writeFile(OUTPUT_PATH, bytes);
      console.log("\nDONE");
      console.log(`  taskId: ${taskId}`);
      console.log(`  bytes:  ${bytes.byteLength}`);
      console.log(`  saved:  ${OUTPUT_PATH}`);
      return;
    }

    if (task.status === "FAILED" || task.status === "CANCELED" || task.status === "EXPIRED") {
      exitFailedTask(task);
    }

    if (Date.now() - startedAt >= TIMEOUT_MS) {
      console.error(`Meshy task ${taskId} timed out after ${TIMEOUT_MS} ms (last status ${task.status})`);
      process.exit(1);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
