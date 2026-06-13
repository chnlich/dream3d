import type { PreviewParams, RefineParams } from "./genParams.mjs";

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

// Factory closes over the secret key so the returned functions take only their
// task args: submitPreview(prompt, previewParams), submitRefine(previewTaskId,
// refineParams), pollTask(taskId), etc. Generation params come from the central
// config (src/meshy/genParams.mjs); this client stays param-agnostic.
export function createMeshyClient(apiKey: string) {
  if (apiKey.trim().length === 0) {
    throw new Error("Meshy API key must be a non-empty string");
  }
  const authHeaders = { Authorization: `Bearer ${apiKey}` };

  // Shared submit: POSTs a job body, returns the new task id. Validates the
  // response and fails loud. Never logs the body or the API key.
  async function submitJob(body: Record<string, unknown>): Promise<string> {
    const response = await fetch(`${MESHY_BASE_URL}${TEXT_TO_3D_PATH}`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(body),
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

  // Preview pass: a fast, untextured mesh, remeshed/poly-bounded per previewParams.
  async function submitPreview(prompt: string, previewParams: PreviewParams): Promise<string> {
    return submitJob({
      mode: "preview",
      prompt,
      target_formats: ["glb"],
      should_remesh: previewParams.should_remesh,
      target_polycount: previewParams.target_polycount,
      topology: previewParams.topology,
      ai_model: previewParams.ai_model,
    });
  }

  // Refine pass: bakes PBR texture onto a completed preview task; returns the new
  // (refined) task id, polled/downloaded exactly like a preview task.
  async function submitRefine(previewTaskId: string, refineParams: RefineParams): Promise<string> {
    return submitJob({
      mode: "refine",
      preview_task_id: previewTaskId,
      enable_pbr: refineParams.enable_pbr,
      remove_lighting: refineParams.remove_lighting,
      hd_texture: refineParams.hd_texture,
      ai_model: refineParams.ai_model,
      target_formats: ["glb"],
    });
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

  return { submitPreview, submitRefine, pollTask, waitForTask, downloadGlb };
}
