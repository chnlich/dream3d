import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { generate } from "../pipeline/orchestrator";
import { publishSceneAssets } from "./assetBridge";
import { logEvent, mirrorRunAssets, withRun } from "../log/audit";
import { loadHistoricalJobs, persistJob } from "./jobStore";
import type { JobStatus, ProgressEvent } from "../api/contract";

// Vite dev-middleware plugin for the dream3d backend:
//   POST /api/generate         { prompt, amendRounds } -> 202 { jobId } (starts a background run)
//   GET  /api/generate/<jobId>                         -> 200 JobStatus (poll for progress + result)
//   GET  /assets/<id>.glb                              -> static GLB from dataDir/assets
//
// dataDir follows the convention shared with scripts/meshy-generate.mjs
// (~/.cache/dream3d).
const dataDir = join(homedir(), ".cache", "dream3d");
const assetsDir = join(dataDir, "assets");

// A generate run is minute-scale in real mode, so POST starts it in the background and returns a
// jobId; the client polls for the streaming log + final result. The in-memory Map is the primary
// job store, hydrated from disk on server start and persisted to disk on every state change so jobs
// survive a Vite dev-server restart.
const jobs = new Map<string, JobStatus>();

export function apiPlugin(): Plugin {
  return {
    name: "dream3d-api",
    configureServer(server) {
      for (const [jobId, job] of loadHistoricalJobs()) {
        jobs.set(jobId, job);
      }
      server.middlewares.use("/api/generate", (req, res) => {
        void handleGenerate(req, res);
      });
      server.middlewares.use("/assets", (req, res, next) => {
        serveAsset(req, res, next);
      });
    },
  };
}

// Routes within the existing "/api/generate" prefix mount by method + remainder url (Vite strips the
// mount path, so req.url is "/" for the bare path and "/<jobId>" for a subpath):
//   POST "/"        -> start a job, respond 202 { jobId }
//   GET  "/<jobId>" -> respond 200 JobStatus (404 if the id is unknown)
async function handleGenerate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = (req.url ?? "/").split("?")[0];

  if (req.method === "GET") {
    const jobId = url.replace(/^\//, "");
    if (jobId.length === 0) {
      sendJson(res, 405, { error: "method not allowed; GET requires a job id at /api/generate/<jobId>" });
      return;
    }
    const job = jobs.get(jobId);
    if (!job) {
      sendJson(res, 404, { error: `no job with id "${jobId}"` });
      return;
    }
    sendJson(res, 200, job);
    return;
  }

  if (req.method === "POST" && (url === "/" || url === "")) {
    try {
      const parsed = JSON.parse(await readBody(req)) as { prompt?: unknown; amendRounds?: unknown };
      if (typeof parsed.prompt !== "string" || parsed.prompt.trim().length === 0) {
        sendJson(res, 400, { error: "`prompt` must be a non-empty string" });
        return;
      }
      if (typeof parsed.amendRounds !== "number" || !Number.isInteger(parsed.amendRounds) || parsed.amendRounds < 0) {
        sendJson(res, 400, { error: "`amendRounds` must be a non-negative integer" });
        return;
      }
      // Capture the validated inputs as consts so their narrowed types (string / number) survive into
      // the withRun closure below — TS control-flow narrowing of `parsed.*` does not cross a closure.
      const prompt = parsed.prompt;
      const amendRounds = parsed.amendRounds;
      const jobId = crypto.randomUUID();
      const job: JobStatus = { status: "running", log: [] };
      jobs.set(jobId, job);
      persistJob(jobId, job);
      // Start the run WITHOUT awaiting — the client polls GET /api/generate/<jobId> for progress.
      // withRun binds jobId as the audit runId for the WHOLE promise chain (a synchronous call that
      // returns at once), so every nested runClaude / meshyAssetProvider call and the progress mirror
      // below land under <logRoot>/<jobId>/. It does NOT await — sendJson(202) still fires immediately.
      withRun(jobId, () => {
        // Each ProgressEvent is timestamped + appended to job.log as an English line (formatEvent) and
        // mirrored verbatim to the run's events.jsonl — its own `kind` (plan/asset_done/done/…) tags the
        // line and sets it apart from the llm.call records. Best-effort; logEvent runs in-context.
        generate(prompt, amendRounds, (ev) => {
          if (ev.kind === "cached") {
            job.cached = true;
          }
          job.log.push({ ts: Date.now(), text: formatEvent(ev) });
          logEvent({ ...ev });
          persistJob(jobId, job);
        })
          .then((result) => {
            job.status = "done";
            // Audit-copy the raw LOCAL GLBs before the /assets rewrite (best-effort, never throws).
            mirrorRunAssets(result);
            // Bridge ready GLBs to browser-fetchable /assets URLs HERE (the poll result, where the
            // passes reach the client) — NOT on the POST response, which only carries the jobId.
            job.result = publishSceneAssets(result);
            persistJob(jobId, job);
          })
          .catch((err) => {
            job.status = "error";
            job.error = err instanceof Error ? err.message : String(err);
            console.error("[dream3d-api] job failed:", err);
            persistJob(jobId, job);
          });
      });
      sendJson(res, 202, { jobId });
    } catch (error) {
      // Surface the failure to both the client and the dev console — never swallow.
      console.error("[dream3d-api] /api/generate failed:", error);
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  sendJson(res, 405, { error: "method not allowed" });
}

// Render a ProgressEvent to a concise English log line for the live Studio log.
function formatEvent(ev: ProgressEvent): string {
  switch (ev.kind) {
    case "plan":
      return "Planning scene…";
    case "plan_done":
      return `Plan ready — ${ev.objectCount} object(s)`;
    case "asset_start":
      return `Starting asset ${ev.index + 1}/${ev.total}: ${ev.label}`;
    case "asset_done":
      return `Generating asset ${ev.completed}/${ev.total}: ${ev.label}`;
    case "layout":
      return "Arranging layout…";
    case "render":
      return `Amend ${ev.round}: rendering`;
    case "blank_warning":
      return `Render warning for ${ev.view}: ${ev.warning}`;
    case "critique":
      return `Amend ${ev.round}: ${ev.issueCount} issue(s) found`;
    case "fix":
      return `Amend ${ev.round}: applied fixes`;
    case "clean":
      return `Amend ${ev.round}: clean`;
    case "done":
      return `Done — ${ev.passCount} pass(es)`;
    case "cached":
      return "Response served from cache";
  }
}

function serveAsset(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    next();
    return;
  }
  // Mounted at "/assets", so req.url is the remainder, e.g. "/sofa.glb".
  const rel = (req.url ?? "/").split("?")[0];
  const filePath = normalize(join(assetsDir, rel));
  if (!filePath.startsWith(assetsDir)) {
    res.statusCode = 403;
    res.end("forbidden");
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.statusCode = 404;
    res.end("asset not found");
    return;
  }
  res.statusCode = 200;
  res.setHeader("content-type", "model/gltf-binary");
  createReadStream(filePath).pipe(res);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
