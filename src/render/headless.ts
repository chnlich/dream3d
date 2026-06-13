// Reusable headless render harness for dream3d.
//
// Renders a small, self-contained scene description to a PNG using headless
// Chromium + software WebGL (SwiftShader). This is the server-side capture path
// that lets the agent loop screenshot a scene and feed it to the Opus vision
// critic (PLAN.md step 4). See docs/headless-render.md for the host setup and
// the SceneState integration notes.
//
// Design:
//   - A tiny zero-dependency HTTP server serves the render page, the vendored
//     three.js build, and any local GLB assets. Chromium navigates to it. We use
//     a real http:// origin (not file://) so ES-module importmaps and GLB fetches
//     resolve cleanly.
//   - The browser-side logic lives in scene-page.js; it renders one frame and
//     exposes the PNG (canvas.toDataURL) + pixel stats on `window`.
//   - We deliberately do NOT import the project SceneState schema here (it is
//     built in parallel). Callers map SceneState -> RenderInput; see the docs.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, resolve as resolvePath, basename } from "node:path";
import { homedir } from "node:os";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = join(MODULE_DIR, "vendor", "three");
const SCENE_PAGE_PATH = join(MODULE_DIR, "scene-page.js");
const SCENE_VISUALS_PATH = join(MODULE_DIR, "sceneVisuals.js");

// ---------------------------------------------------------------------------
// Local input type (intentionally NOT the project SceneState schema).
// ---------------------------------------------------------------------------

export type Vec3 = [number, number, number];

export interface RenderObject {
  /** Absolute http(s) URL OR a local filesystem path to a .glb. Takes priority over `primitive`. */
  glbUrl?: string;
  /** Built-in primitive to render when there is no glbUrl. */
  primitive?: "box" | "cylinder";
  /** World-space position [x, y, z]. y is up; the floor is at y=0. */
  position: Vec3;
  /** Yaw rotation about the Y axis, in degrees. */
  rotationYDeg: number;
  /** Uniform scale factor. */
  scale: number;
  /** Optional override color (0xRRGGBB) for primitives. */
  color?: number;
  /** intended bbox (m); when present the page fits the model to it */
  approxSize?: Vec3;
}

export interface RenderInput {
  /** Room dimensions in world units; rendered as a single open floor plane (no walls), centered at the origin. */
  room: { width: number; depth: number; height: number };
  objects: RenderObject[];
  /** Optional explicit camera; when omitted a 3/4 framing of the whole room is used. */
  camera?: { position: Vec3; target: Vec3 };
}

export interface RenderOptions {
  width?: number;
  height?: number;
  /** Background / clear color, 0xRRGGBB. */
  clearColor?: number;
  /** Hard timeout for the in-browser render, in milliseconds. */
  timeoutMs?: number;
  /**
   * An already-launched Playwright Browser to reuse. When provided it is NOT
   * closed by this call — the agent loop should launch one browser (launchBrowser)
   * and reuse it across all vision passes to avoid paying cold-start per render.
   */
  browser?: any;
}

export interface RenderStats {
  width: number;
  height: number;
  distinctColors: number;
  nonBackgroundFraction: number;
  meanLuminance: number;
  luminanceStdDev: number;
}

export interface RenderResult {
  png: Buffer;
  stats: RenderStats;
  /** Wall-clock milliseconds spent inside renderSceneToPng (server + launch + render). */
  durationMs: number;
}

const DEFAULTS = { width: 1024, height: 768, clearColor: 0x1f262e, timeoutMs: 30_000 };

// Chromium flags that make WebGL work in headless Chromium on a GPU-less WSL host.
// SwiftShader is Chromium's software GL backend; recent Chromium gates it behind
// --enable-unsafe-swiftshader. --no-sandbox is required under WSL.
export const CHROMIUM_LAUNCH_ARGS = [
  "--no-sandbox",
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--disable-dev-shm-usage",
];

// Host location where Chromium's system libraries were extracted (see docs).
// We mutate LD_LIBRARY_PATH in-process before launch so the spawned browser
// child inherits it; Node itself does not need these libraries.
const HOST_LIB_DIRS = [
  join(homedir(), "tools", "playwright-libs", "ubuntu2204", "usr", "lib", "x86_64-linux-gnu"),
  join(homedir(), "tools", "playwright-libs", "ubuntu2204", "lib", "x86_64-linux-gnu"),
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Render `input` to a PNG buffer. This is the signature the agent loop consumes. */
export async function renderToPng(input: RenderInput, options: RenderOptions = {}): Promise<Buffer> {
  const result = await renderSceneToPng(input, options);
  return result.png;
}

/** Like renderToPng, but also returns pixel stats + timing (used by the smoke + benchmarks). */
export async function renderSceneToPng(input: RenderInput, options: RenderOptions = {}): Promise<RenderResult> {
  const opts = { ...DEFAULTS, ...options };
  const startedAt = performance.now();

  const { servedInput, assets } = registerLocalAssets(input);
  const html = buildHtml(servedInput, opts);
  const server = await startServer(html, assets);
  try {
    const result = await driveBrowser(server.origin, opts, options.browser);
    return { ...result, durationMs: performance.now() - startedAt };
  } finally {
    await server.close();
  }
}

/**
 * Launch a Chromium browser configured for headless software-WebGL rendering on
 * this host. Reuse one instance across many renderToPng calls (pass it via
 * RenderOptions.browser) and close it when done.
 */
export async function launchBrowser(): Promise<any> {
  ensureLibraryPath();
  const chromium = await resolveChromium();
  return chromium.launch({ headless: true, args: CHROMIUM_LAUNCH_ARGS });
}

/** Throws if `stats` indicates a blank/degenerate frame. Shared by the smoke script. */
export function assertNonBlank(stats: RenderStats): void {
  if (stats.distinctColors < 8) {
    throw new Error(`Render looks blank: only ${stats.distinctColors} distinct colors`);
  }
  if (stats.nonBackgroundFraction < 0.02) {
    throw new Error(`Render looks blank: only ${(stats.nonBackgroundFraction * 100).toFixed(2)}% of pixels differ from the background`);
  }
  if (stats.luminanceStdDev < 4) {
    throw new Error(`Render looks blank: luminance std-dev ${stats.luminanceStdDev.toFixed(2)} is too flat`);
  }
}

// ---------------------------------------------------------------------------
// Browser driver
// ---------------------------------------------------------------------------

async function driveBrowser(origin: string, opts: typeof DEFAULTS, reusedBrowser?: any): Promise<{ png: Buffer; stats: RenderStats }> {
  const browser = reusedBrowser ?? (await launchBrowser());
  const ownsBrowser = !reusedBrowser;
  let page: any = null;
  try {
    page = await browser.newPage({ viewport: { width: opts.width, height: opts.height }, deviceScaleFactor: 1 });
    const consoleLines: string[] = [];
    page.on("console", (msg: { type(): string; text(): string }) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
    page.on("pageerror", (err: Error) => consoleLines.push(`[pageerror] ${err.message}`));

    await page.goto(origin, { waitUntil: "load" });
    await page.waitForFunction(
      () => (window as any).__renderState === "done" || (window as any).__renderState === "error",
      undefined,
      { timeout: opts.timeoutMs },
    );

    const state = await page.evaluate(() => (window as any).__renderState);
    if (state !== "done") {
      const pageError = await page.evaluate(() => (window as any).__renderError);
      throw new Error(`In-browser render failed:\n${pageError}\n--- console ---\n${consoleLines.join("\n")}`);
    }

    const dataUrl = (await page.evaluate(() => (window as any).__png)) as string;
    const stats = (await page.evaluate(() => (window as any).__stats)) as RenderStats;
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) {
      throw new Error("Render produced no PNG data URL");
    }
    return { png: Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64"), stats };
  } finally {
    if (page) {
      await page.close();
    }
    if (ownsBrowser) {
      await browser.close();
    }
  }
}

async function resolveChromium(): Promise<any> {
  // Prefer the project's own playwright (present after `npm install` at integration
  // time); fall back to the documented host install used for this spike.
  const candidates = ["playwright", join(homedir(), "tools", "playwright", "node_modules", "playwright", "index.js")];
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      const mod = await import(candidate);
      const chromium = (mod.chromium ?? mod.default?.chromium) as any;
      if (chromium) {
        return chromium;
      }
      errors.push(`${candidate}: module loaded but no chromium export`);
    } catch (error) {
      errors.push(`${candidate}: ${(error as Error).message}`);
    }
  }
  throw new Error(`Could not load Playwright. Tried:\n  ${errors.join("\n  ")}\nSee docs/headless-render.md for setup.`);
}

function ensureLibraryPath(): void {
  const current = process.env.LD_LIBRARY_PATH ?? "";
  const parts = current.split(":").filter(Boolean);
  let changed = false;
  for (const dir of HOST_LIB_DIRS) {
    if (existsSync(dir) && !parts.includes(dir)) {
      parts.unshift(dir);
      changed = true;
    }
  }
  if (changed) {
    process.env.LD_LIBRARY_PATH = parts.join(":");
  }
}

// ---------------------------------------------------------------------------
// Local HTTP server (page + vendored three + GLB assets)
// ---------------------------------------------------------------------------

interface ServerHandle {
  origin: string;
  close(): Promise<void>;
}

async function startServer(html: string, assets: Map<string, string>): Promise<ServerHandle> {
  const port = await getFreePort();
  const server = createServer((req, res) => handleRequest(req, res, html, assets));
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, html: string, assets: Map<string, string>): Promise<void> {
  const url = (req.url ?? "/").split("?")[0];
  try {
    if (url === "/") {
      return send(res, 200, "text/html; charset=utf-8", Buffer.from(html));
    }
    if (url === "/scene-page.js") {
      return send(res, 200, "text/javascript; charset=utf-8", await readFile(SCENE_PAGE_PATH));
    }
    if (url === "/sceneVisuals.js") {
      return send(res, 200, "text/javascript; charset=utf-8", await readFile(SCENE_VISUALS_PATH));
    }
    if (url.startsWith("/vendor/three/")) {
      const rel = url.slice("/vendor/three/".length);
      const filePath = normalize(join(VENDOR_DIR, rel));
      if (!filePath.startsWith(VENDOR_DIR)) {
        return send(res, 403, "text/plain", Buffer.from("forbidden"));
      }
      return send(res, 200, mimeFor(filePath), await readFile(filePath));
    }
    if (url.startsWith("/assets/")) {
      const filePath = assets.get(url);
      if (!filePath) {
        return send(res, 404, "text/plain", Buffer.from("unknown asset"));
      }
      return send(res, 200, "model/gltf-binary", await readFile(filePath));
    }
    return send(res, 404, "text/plain", Buffer.from("not found"));
  } catch (error) {
    // Surface server-side read errors instead of hanging the page.
    send(res, 500, "text/plain", Buffer.from(`server error: ${(error as Error).message}`));
  }
}

function send(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { "content-type": contentType, "content-length": body.length });
  res.end(body);
}

function mimeFor(filePath: string): string {
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".glb")) return "model/gltf-binary";
  if (filePath.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address === "string" || address === null) {
        reject(new Error("could not allocate a TCP port"));
        return;
      }
      const { port } = address;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

// ---------------------------------------------------------------------------
// Asset registration + HTML
// ---------------------------------------------------------------------------

// Local-file glbUrls are served by our http server (browsers can't fetch file://
// from an http page). http(s) URLs are left untouched for the page to fetch.
function registerLocalAssets(input: RenderInput): { servedInput: RenderInput; assets: Map<string, string> } {
  const assets = new Map<string, string>();
  const objects = input.objects.map((obj, index) => {
    if (!obj.glbUrl || /^https?:\/\//.test(obj.glbUrl)) {
      return obj;
    }
    const filePath = resolvePath(obj.glbUrl);
    if (!existsSync(filePath)) {
      throw new Error(`object[${index}] glbUrl does not exist: ${filePath}`);
    }
    const servePath = `/assets/${index}-${basename(filePath)}`;
    assets.set(servePath, filePath);
    return { ...obj, glbUrl: servePath };
  });
  return { servedInput: { ...input, objects }, assets };
}

function buildHtml(input: RenderInput, opts: typeof DEFAULTS): string {
  const importmap = JSON.stringify({
    imports: { three: "/vendor/three/three.module.js", "three/addons/": "/vendor/three/addons/" },
  });
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>html,body{margin:0;padding:0;background:#000;overflow:hidden}#c{display:block;width:${opts.width}px;height:${opts.height}px}</style>
<script type="importmap">${importmap}</script>
</head>
<body>
<canvas id="c" width="${opts.width}" height="${opts.height}"></canvas>
<script>
window.__INPUT__ = ${JSON.stringify(input)};
window.__OPTS__ = ${JSON.stringify({ width: opts.width, height: opts.height, clearColor: opts.clearColor })};
</script>
<script type="module" src="/scene-page.js"></script>
</body>
</html>`;
}
