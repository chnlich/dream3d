// Reusable headless render harness for dream3d.
//
// Renders a small, self-contained scene description to a PNG using headless
// Chromium. By default it drives the real GPU (ANGLE -> D3D12; the discrete
// NVIDIA GPU on this WSL host) and falls back — loudly — to software WebGL
// (SwiftShader) when full Chromium is unavailable. This is the server-side
// capture path that lets the agent loop screenshot a scene and feed it to the
// Opus vision critic. See docs/headless-render.md for the host setup and
// the SceneState integration notes.
//
// Design:
//   - A tiny zero-dependency HTTP server serves the render page, the vendored
//     three.js build, and any local GLB assets. Chromium navigates to it. We use
//     a real http:// origin (not file://) so ES-module importmaps and GLB fetches
//     resolve cleanly.
//   - The browser-side logic lives in scene-page.js; it builds the scene + loads
//     the GLBs ONCE on load, then exposes window.__renderView(camera) so the Node
//     side can capture many angles (canvas.toDataURL + pixel stats) against that
//     one already-loaded scene. createRenderSession is the persistent wrapper;
//     renderSceneToPng is a one-shot built on top of it.
//   - We deliberately do NOT import the project SceneState schema here (it is
//     built in parallel). Callers map SceneState -> RenderInput; see the docs.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
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

/**
 * A persistent render session over ONE scene: the local asset server, the
 * Chromium page, the navigation, and the scene + GLB load are all paid ONCE on
 * creation. `renderView` then captures an arbitrary camera angle against that
 * already-loaded scene — so multi-angle capture pays a single navigation + parse
 * and each extra angle is render-only. Created via createRenderSession.
 */
export interface RenderSession {
  /**
   * Render the loaded scene from `camera` and return the PNG + pixel stats. When
   * `camera` is omitted, the camera baked into the session's RenderInput (or the
   * default 3/4 framing) is used. Call sequentially — all views share one page
   * and canvas (under SwiftShader concurrent renders only contend on CPU anyway).
   */
  renderView(camera?: { position: Vec3; target: Vec3 }): Promise<{ png: Buffer; stats: RenderStats }>;
  /** Tear down the page + local server (and the browser, iff this session owns it). */
  close(): Promise<void>;
}

const DEFAULTS = { width: 1024, height: 768, clearColor: 0x1f262e, timeoutMs: 30_000 };

// Software-WebGL (SwiftShader) launch flags — the portable fallback used when the
// real GPU path is unavailable or disabled. SwiftShader is Chromium's software GL
// backend; recent Chromium gates it behind --enable-unsafe-swiftshader.
// --no-sandbox is required under WSL. Kept under the original export name for
// back-compat with existing importers; the GPU flags live in GPU_LAUNCH_ARGS below.
export const CHROMIUM_LAUNCH_ARGS = [
  "--no-sandbox",
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--disable-dev-shm-usage",
];

// Real-GPU launch flags: ANGLE -> D3D12 on this WSL host. Empirically (see the GPU
// probe + docs/headless-render.md) this is the ONLY combination that engages the
// discrete NVIDIA RTX 3060 here — Vulkan, EGL, and desktop GL all fell back to
// SwiftShader. Requires FULL Chromium (channel:"chromium"); the default
// headless_shell always falls back to software. Pairs with the /usr/lib/wsl/lib
// LD_LIBRARY_PATH prepend + MESA_D3D12_DEFAULT_ADAPTER_NAME set before launch.
export const GPU_LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--headless=new",
  "--ignore-gpu-blocklist",
  "--use-gl=angle",
  "--use-angle=gl",
];

// Host location where Chromium's system libraries were extracted (see docs).
// We mutate LD_LIBRARY_PATH in-process before launch so the spawned browser
// child inherits it; Node itself does not need these libraries. The directory
// name follows the OS codename so the same harness works on Ubuntu 22.04 and
// 24.04 (the setup script extracts the .debs to ubuntu2204 / ubuntu2404).
function getHostLibDirs(): string[] {
  const codename = detectUbuntuCodename();
  const suffix = codename === "noble" ? "ubuntu2404" : "ubuntu2204";
  return [
    join(homedir(), "tools", "playwright-libs", suffix, "usr", "lib", "x86_64-linux-gnu"),
    join(homedir(), "tools", "playwright-libs", suffix, "lib", "x86_64-linux-gnu"),
  ];
}

function detectUbuntuCodename(): string {
  try {
    const data = readFileSync("/etc/os-release", "utf8");
    const match = data.match(/^VERSION_CODENAME=(.+)$/m);
    const value = match?.[1]?.trim().replace(/^["']|["']$/g, "");
    if (value) return value;
  } catch {
    // fall through to default
  }
  return "jammy";
}

// WSL's GPU userspace libraries (libd3d12, libdxcore, the Mesa d3d12 Gallium
// driver, …). For the GPU path this MUST be prepended FIRST onto the browser
// child's LD_LIBRARY_PATH so ANGLE's D3D12 backend can load the GPU stack; the
// software path does not need it.
const WSL_GPU_LIB_DIR = "/usr/lib/wsl/lib";

// Steers Mesa's d3d12 Gallium driver to the discrete RTX 3060; omitting it picks
// the AMD iGPU (also GPU, slightly slower). Set in-process before launch.
const MESA_ADAPTER_ENV = "MESA_D3D12_DEFAULT_ADAPTER_NAME";
const MESA_ADAPTER_NVIDIA = "NVIDIA";

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
  const startedAt = performance.now();
  // One-shot render: a single-camera session that loads the scene, captures the
  // input's camera (or the default framing), and tears straight back down.
  const session = await createRenderSession(input, options);
  try {
    const { png, stats } = await session.renderView();
    return { png, stats, durationMs: performance.now() - startedAt };
  } finally {
    await session.close();
  }
}

/**
 * Open a persistent render session: start the local asset server, open one page,
 * navigate ONCE, and load scene-page.js + the vendored three build + every GLB in
 * `input` ONCE. The returned session renders arbitrary camera angles against that
 * already-loaded scene (renderView) until you close() it. Reuses an injected
 * `options.browser` (left open on close); otherwise launches and owns one.
 */
export async function createRenderSession(input: RenderInput, options: RenderOptions = {}): Promise<RenderSession> {
  const opts = { ...DEFAULTS, ...options };
  const { servedInput, assets } = registerLocalAssets(input);
  const html = buildHtml(servedInput, opts);
  const server = await startServer(html, assets);

  const browser = options.browser ?? (await launchBrowser());
  const ownsBrowser = !options.browser;

  // Captured across the session so a render failure can report what the page logged.
  const consoleLines: string[] = [];
  let page: any = null;
  try {
    page = await browser.newPage({ viewport: { width: opts.width, height: opts.height }, deviceScaleFactor: 1 });
    page.on("console", (msg: { type(): string; text(): string }) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
    page.on("pageerror", (err: Error) => consoleLines.push(`[pageerror] ${err.message}`));

    // scene-page.js builds the scene + loads all GLBs on load, then flips
    // __renderState to "done" (or "error"). Wait for that here so the first
    // renderView never races an unfinished scene/GLB load.
    await page.goto(server.origin, { waitUntil: "load" });
    await page.waitForFunction(
      () => (window as any).__renderState === "done" || (window as any).__renderState === "error",
      undefined,
      { timeout: opts.timeoutMs },
    );
    const state = await page.evaluate(() => (window as any).__renderState);
    if (state !== "done") {
      const pageError = await page.evaluate(() => (window as any).__renderError);
      throw new Error(`In-browser scene build failed:\n${pageError}\n--- console ---\n${consoleLines.join("\n")}`);
    }
  } catch (error) {
    // Scene never loaded — release everything this call opened (do NOT close an
    // injected browser) before propagating.
    if (page) {
      await page.close();
    }
    await server.close();
    if (ownsBrowser) {
      await browser.close();
    }
    throw error;
  }

  return {
    async renderView(camera?: { position: Vec3; target: Vec3 }): Promise<{ png: Buffer; stats: RenderStats }> {
      const result = (await page.evaluate(
        (cam: { position: Vec3; target: Vec3 } | null) => (window as any).__renderView(cam),
        camera ?? null,
      )) as { png: string; stats: RenderStats };
      const dataUrl = result.png;
      if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) {
        throw new Error(`Render produced no PNG data URL\n--- console ---\n${consoleLines.join("\n")}`);
      }
      return { png: Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64"), stats: result.stats };
    },
    async close(): Promise<void> {
      await page.close();
      await server.close();
      if (ownsBrowser) {
        await browser.close();
      }
    },
  };
}

/**
 * Launch a Chromium browser for headless rendering on this host. By default it
 * targets the real GPU (ANGLE -> D3D12 on the discrete NVIDIA GPU) via FULL
 * Chromium (channel:"chromium" + GPU_LAUNCH_ARGS); if that throws — e.g. full
 * Chromium is not installed — it warns LOUDLY and falls back to the software
 * (SwiftShader) path. Set DREAM3D_HEADLESS_GPU=0 to skip the GPU attempt entirely
 * (portability / debug escape hatch). After launch it logs the live WebGL renderer
 * string so logs show which backend engaged. Reuse one instance across many
 * renderToPng calls (pass it via RenderOptions.browser) and close it when done.
 */
export async function launchBrowser(): Promise<any> {
  const chromium = await resolveChromium();
  const browser = await launchConfiguredBrowser(chromium);
  await logWebglRenderer(browser);
  return browser;
}

// Picks GPU vs software and performs the actual chromium.launch. Default path:
// set up the GPU env (LD_LIBRARY_PATH prepend + MESA adapter) and launch full
// Chromium with the GPU flags; on failure warn loudly and launch the software
// path. DREAM3D_HEADLESS_GPU=0 forces software up front. Throws only if the
// software launch also fails (i.e. both paths are unavailable).
async function launchConfiguredBrowser(chromium: any): Promise<any> {
  if (process.env.DREAM3D_HEADLESS_GPU === "0") {
    ensureLibraryPath(false);
    return chromium.launch({ headless: true, args: CHROMIUM_LAUNCH_ARGS });
  }
  ensureLibraryPath(true);
  setMesaAdapter();
  try {
    return await chromium.launch({ channel: "chromium", headless: true, args: GPU_LAUNCH_ARGS });
  } catch (error) {
    console.warn(
      `[headless] GPU Chromium unavailable (${(error as Error).message}); falling back to SwiftShader software render`,
    );
    return chromium.launch({ headless: true, args: CHROMIUM_LAUNCH_ARGS });
  }
}

// MESA_D3D12_DEFAULT_ADAPTER_NAME=NVIDIA steers Mesa's d3d12 driver to the discrete
// RTX 3060 (omitting it picks the AMD iGPU). Respect a value the user already set.
function setMesaAdapter(): void {
  if (!process.env[MESA_ADAPTER_ENV]) {
    process.env[MESA_ADAPTER_ENV] = MESA_ADAPTER_NVIDIA;
  }
}

// Diagnostic (permanent, for auditability): open a throwaway page, read the live
// WebGL UNMASKED_RENDERER, and log it so it is visible in logs whether the GPU
// (ANGLE -> D3D12 (NVIDIA ...)) or the SwiftShader software backend engaged. A
// failure to read it must not break an otherwise-working browser, so it is logged
// rather than thrown.
async function logWebglRenderer(browser: any): Promise<void> {
  let page: any = null;
  try {
    page = await browser.newPage();
    const renderer = await page.evaluate(() => {
      const gl = document.createElement("canvas").getContext("webgl2");
      if (!gl) return "no WebGL2 context";
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    });
    console.log(`[headless] WebGL renderer: ${renderer}`);
  } catch (error) {
    console.warn(`[headless] could not read WebGL renderer for diagnostics: ${(error as Error).message}`);
  } finally {
    if (page) {
      await page.close();
    }
  }
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
// Chromium resolution
// ---------------------------------------------------------------------------

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

// Prepend the dirs the browser child needs onto LD_LIBRARY_PATH, in-process,
// before launch (the child inherits it; Node itself does not need them). Both
// paths get the extracted playwright-libs system libs; the GPU path additionally
// prepends WSL_GPU_LIB_DIR FIRST so ANGLE's D3D12 backend finds the GPU stack.
function ensureLibraryPath(gpu: boolean): void {
  // Front-of-path priority order. unshift below reverses, so iterate in reverse
  // to land this exact order at the front (WSL GPU libs first when gpu).
  const wanted = (gpu ? [WSL_GPU_LIB_DIR, ...getHostLibDirs()] : getHostLibDirs()).filter((dir) => existsSync(dir));
  const parts = (process.env.LD_LIBRARY_PATH ?? "").split(":").filter(Boolean);
  let changed = false;
  for (let i = wanted.length - 1; i >= 0; i--) {
    if (!parts.includes(wanted[i])) {
      parts.unshift(wanted[i]);
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
