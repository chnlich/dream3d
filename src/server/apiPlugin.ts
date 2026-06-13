import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { generate } from "../pipeline/orchestrator";

// Vite dev-middleware plugin for the dream3d backend:
//   POST /api/generate { prompt, amendRounds }  -> { passes } (runs the orchestrator)
//   GET  /assets/<id>.glb                       -> static GLB from dataDir/assets
//
// dataDir follows the convention shared with scripts/meshy-generate.mjs
// (~/.cache/dream3d). The orchestrator defaults to MOCK mode, so this works
// offline with no keys.
const dataDir = join(homedir(), ".cache", "dream3d");
const assetsDir = join(dataDir, "assets");

export function apiPlugin(): Plugin {
  return {
    name: "dream3d-api",
    configureServer(server) {
      server.middlewares.use("/api/generate", (req, res) => {
        void handleGenerate(req, res);
      });
      server.middlewares.use("/assets", (req, res, next) => {
        serveAsset(req, res, next);
      });
    },
  };
}

async function handleGenerate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method not allowed; use POST" });
    return;
  }
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
    const result = await generate(parsed.prompt, parsed.amendRounds);
    sendJson(res, 200, result);
  } catch (error) {
    // Surface the failure to both the client and the dev console — never swallow.
    console.error("[dream3d-api] /api/generate failed:", error);
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
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
