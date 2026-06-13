# Meshy text-to-3D — verified request flow

Reference for calling the [Meshy.ai](https://docs.meshy.ai/) text-to-3D API from the dream3d
backend. This captures the flow we tested live so M1/M2 do not have to rediscover it.

**Label legend**

- **[VERIFIED 2026-06-13]** — tested live against the real Meshy API from this project.
- **[DOCUMENTED, UNVERIFIED]** — taken from Meshy's docs; not yet exercised in this project.

---

## Overview

A 3-step async flow, **one Meshy task per object**:

1. **Submit** a text-to-3D job → get a `taskId` back immediately (the job runs async).
2. **Poll** that task until it reaches a terminal status.
3. **Download** the resulting GLB from a presigned URL.

Two generation modes:

- `preview` — a fast, **UNtextured gray mesh**. This is what dream3d uses for the live demo.
- `refine` — a second pass that **adds texture** on top of a completed preview task.

> The whole flow is **minute-scale and asynchronous**. Design around that (see Gotchas).

---

## Auth

Every API call carries the secret key in an HTTP header:

```
Authorization: Bearer <MESHY_API_KEY>
```

The key is a secret. Load it from the **gitignored** `config/local.json`
(shape `{ "meshyApiKey": "msy_..." }`) at the repo root. **Never hardcode it, never commit it,
and never log it.** (dream3d uses config files over env vars.)

---

## Step 1 — Submit  [VERIFIED 2026-06-13]

```
POST https://api.meshy.ai/openapi/v2/text-to-3d
Authorization: Bearer <key>
Content-Type: application/json
```

Body:

```json
{ "mode": "preview", "prompt": "<text>", "target_formats": ["glb"] }
```

Response — **HTTP 202**:

```json
{ "result": "<taskId>" }
```

`result` is the task id used for polling and download.

### Optional body fields

- `art_style` — **v2 ONLY accepts `"realistic"`.** Any other value returns **HTTP 400**
  with `{"message":"Invalid values: ArtStyle must be one of [realistic]"}`. **[VERIFIED 2026-06-13]**
- `should_remesh`, `topology`, `target_polycount`, `symmetry_mode` — accepted per Meshy docs
  to tune the output mesh. **[DOCUMENTED, UNVERIFIED]**

---

## Step 2 — Poll  [VERIFIED 2026-06-13]

```
GET https://api.meshy.ai/openapi/v2/text-to-3d/{taskId}
Authorization: Bearer <key>
```

Response shape:

```json
{
  "id": "...",
  "model_type": "meshy-5",
  "type": "preview",
  "status": "PENDING | IN_PROGRESS | SUCCEEDED | FAILED | CANCELED | EXPIRED",
  "progress": 0,
  "seed": 1234567890,
  "consumed_credits": 20,
  "model_urls": {
    "glb": "https://assets.meshy.ai/.../model.glb?Expires=...&Signature=...&Key-Pair-Id=..."
  },
  "thumbnail_url": "https://assets.meshy.ai/.../preview.png?...",
  "video_url": "https://assets.meshy.ai/.../output.mp4?...",
  "texture_richness": "high",
  "remove_lighting": false,
  "negative_prompt": "",
  "created_at": 1781377450000,
  "started_at": 1781377451000,
  "finished_at": 1781377535000,
  "task_error": { "message": "..." }
}
```

- `status` is one of the six values above. `SUCCEEDED` is the only success state;
  `FAILED` / `CANCELED` / `EXPIRED` are terminal failures. `PENDING` / `IN_PROGRESS` mean keep polling.
- `progress` runs `0`–`100`.
- `model_urls.glb` is populated once the task succeeds.
- `task_error.message` carries the failure reason when a task fails.

Additional fields observed live **[VERIFIED 2026-06-13]**:

- `type` — the task mode (`"preview"` or `"refine"`); `model_type` — the generating model (e.g. `"meshy-5"`).
- `seed` — integer; **reproducible** (re-submitting with the same seed reproduces the mesh).
- `consumed_credits` — integer; the **exact** credit cost of this task (preview `20`, refine `10`).
- `created_at` / `started_at` / `finished_at` — **epoch milliseconds** for the task lifecycle.
- `texture_richness`, `remove_lighting`, `negative_prompt` — the texture/generation knobs echoed back.
- `video_url` — a presigned turntable preview video (expires like the other asset URLs).

**Poll cadence ~5–8s.** A `preview` job was observed reaching `SUCCEEDED` (progress `100`)
in **well under 60s**. **[VERIFIED 2026-06-13]**

---

## Step 3 — Download  [VERIFIED 2026-06-13]

```
GET <model_urls.glb>
```

- It is a **presigned CloudFront URL** — send **NO `Authorization` header** (adding one can break it).
- Returns the **binary GLB** body.
- The URL carries an `Expires` param: treat these URLs as **expiring**. **Persist the downloaded
  bytes**, never the URL.

---

## Refine (texture pass)  [VERIFIED 2026-06-13]

> Now exercised live from this project (see `scripts/meshy-generate.mjs --mode refine`). A refine
> pass runs on top of a completed `preview` task and adds PBR texture.

```
POST https://api.meshy.ai/openapi/v2/text-to-3d
Authorization: Bearer <key>
Content-Type: application/json
```

Body:

```json
{ "mode": "refine", "preview_task_id": "<previewTaskId>" }
```

Submitting this body returns a **new task id** (HTTP 202, same `{ "result": "<taskId>" }` shape);
poll and download it identically to a preview task.

- **Cost: 10 credits — HALF of a preview**, not more. (Earlier docs guessed "costs more"; live runs
  show refine is *cheaper* than the 20-credit preview.) **[VERIFIED 2026-06-13]**
- **Timing: ~79s** to `SUCCEEDED` — comparable to a preview. **[VERIFIED 2026-06-13]**
- A refined task returns **all formats** in `model_urls` — `glb`, `fbx`, `usdz`, `obj`, `mtl`, `stl`
  — plus PBR **`texture_urls`** (e.g. `base_color`, alongside the metallic/roughness/normal maps).
  **[VERIFIED 2026-06-13]**

---

## Balance  [VERIFIED 2026-06-13]

```
GET https://api.meshy.ai/openapi/v1/balance
Authorization: Bearer <key>
```

Response:

```json
{ "balance": 8211 }
```

`balance` is an integer credit count.

---

## Cost & timing  [VERIFIED 2026-06-13]

- **1 preview = 20 credits** (~85s) — balance went `8231` → `8211` across one preview job; produces an
  **untextured gray mesh**.
- **1 refine = 10 credits** (~79s) — **half** the cost of a preview; adds PBR texture on top of a
  completed preview.

---

## Gotchas / pitfalls

- **`art_style` only accepts `"realistic"` in v2** — anything else is an HTTP 400.
- **`preview` is untextured (gray)** — you need a `refine` pass to add texture.
- **`model_urls.glb` is presigned and expires** — save the bytes, do not persist the URL.
- **Generation is async and minute-scale.** For a live demo:
  - **cap objects** (4–6),
  - **cache by prompt** (skip regenerating identical objects),
  - **limit concurrency** (≤ 3 in-flight submits),
  - **pre-generate a fallback GLB set** so a Meshy outage cannot kill the demo.
- **Always poll, and handle `FAILED` / `CANCELED` / `EXPIRED` loudly** — never silently treat a
  failed task as success.

---

## Lift-ready minimal client (TypeScript)

Framework-free, zero-dependency, uses Node's global `fetch` (Node 18+) so M1/M2 can drop it into
the thin backend. This mirrors the proven pattern in the reference implementation (see pointer
below) but is intentionally compact — production code should additionally validate every response
field (the reference impl does, via `requireNonEmptyString` / `requireRecord` helpers).

```ts
const MESHY_BASE_URL = "https://api.meshy.ai";
const TEXT_TO_3D_PATH = "/openapi/v2/text-to-3d";

export interface MeshyTask {
  id: string;
  status: "PENDING" | "IN_PROGRESS" | "SUCCEEDED" | "FAILED" | "CANCELED" | "EXPIRED";
  progress: number;
  modelUrls: { glb?: string };
  taskError?: { message?: string };
}

export interface WaitOptions {
  pollIntervalMs: number;
  timeoutMs: number;
}

// Factory closes over the secret key so the returned functions match the
// signatures M1/M2 want: submitPreview(prompt), pollTask(taskId), etc.
export function createMeshyClient(apiKey: string) {
  if (apiKey.trim().length === 0) {
    throw new Error("Meshy API key must be a non-empty string");
  }
  const authHeaders = { Authorization: `Bearer ${apiKey}` };

  async function submitPreview(prompt: string): Promise<string> {
    const response = await fetch(`${MESHY_BASE_URL}${TEXT_TO_3D_PATH}`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "preview", prompt, target_formats: ["glb"] }),
    });
    if (!response.ok) {
      throw new Error(`Meshy submit failed: HTTP ${response.status} ${await response.text()}`);
    }
    const payload = await response.json();
    const taskId = payload.result;
    if (typeof taskId !== "string" || taskId.trim().length === 0) {
      throw new Error(`Meshy submit returned no task id: ${JSON.stringify(payload)}`);
    }
    return taskId;
  }

  async function pollTask(taskId: string): Promise<MeshyTask> {
    const url = `${MESHY_BASE_URL}${TEXT_TO_3D_PATH}/${encodeURIComponent(taskId)}`;
    const response = await fetch(url, { method: "GET", headers: authHeaders });
    if (!response.ok) {
      throw new Error(`Meshy poll failed: HTTP ${response.status} ${await response.text()}`);
    }
    const payload = await response.json();
    return {
      id: payload.id,
      status: payload.status,
      progress: payload.progress,
      modelUrls: { glb: payload.model_urls?.glb },
      taskError: payload.task_error ? { message: payload.task_error.message } : undefined,
    };
  }

  // Loops until the task succeeds; throws LOUDLY on any terminal failure or timeout.
  async function waitForTask(taskId: string, { pollIntervalMs, timeoutMs }: WaitOptions): Promise<MeshyTask> {
    const startedAt = Date.now();
    for (;;) {
      const task = await pollTask(taskId);
      if (task.status === "SUCCEEDED") {
        return task;
      }
      if (task.status === "FAILED" || task.status === "CANCELED" || task.status === "EXPIRED") {
        const detail = task.taskError?.message ? `: ${task.taskError.message}` : "";
        throw new Error(`Meshy task ${taskId} ended with ${task.status}${detail}`);
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Meshy task ${taskId} timed out after ${timeoutMs} ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  // The GLB URL is a presigned CloudFront URL — do NOT send the Authorization header.
  async function downloadGlb(url: string): Promise<Uint8Array> {
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

  return { submitPreview, pollTask, waitForTask, downloadGlb };
}
```

Typical use:

```ts
const meshy = createMeshyClient(apiKey);
const taskId = await meshy.submitPreview("a small wooden stool");
const task = await meshy.waitForTask(taskId, { pollIntervalMs: 6000, timeoutMs: 5 * 60 * 1000 });
const glbUrl = task.modelUrls.glb;
if (!glbUrl) {
  throw new Error(`Meshy task ${task.id} SUCCEEDED without a GLB URL`);
}
const bytes = await meshy.downloadGlb(glbUrl);
// persist `bytes` — the URL expires.
```

---

## Reference implementation pointer

The battle-tested original lives at:

```
~/workspace/multi-glb-viewer/src/pipeline/meshyAssetProvider.ts
```

Functions worth reading for the full pattern (response validation, timeout handling, status
mapping): `createHttpMeshyTransport`, `submitTextTo3dPreview`, `pollTextTo3dTask`, `downloadGlb`,
`waitForMeshyTask`.

> **dream3d is greenfield.** Reuse the *pattern*, do **not** copy multi-glb-viewer wholesale, and
> do **not** add multi-glb-viewer as a dependency.

---

## Runnable smoke test

[`scripts/meshy-smoke.mjs`](../scripts/meshy-smoke.mjs) exercises submit → poll → download
end-to-end against the live API:

```
node scripts/meshy-smoke.mjs "your prompt"
```

It reads the key from `config/local.json`, saves the GLB to `scripts/.out/smoke.glb`, and
**consumes ~20 Meshy credits per run.**

For a higher-level, **cache-aware best-of-N** generator (submits several candidates, caches by
prompt+mode, optional `refine` pass), see [`scripts/meshy-generate.mjs`](../scripts/meshy-generate.mjs)
— run `node scripts/meshy-generate.mjs --help` for the full spec.
