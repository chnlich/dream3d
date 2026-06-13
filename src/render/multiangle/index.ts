// Multi-angle scene capture — render one PNG per caller-supplied camera.
//
// captureViews() is a thin layer over the merged headless renderer
// (../headless): it resolves each CameraSpec to a concrete { position, target },
// then renders the scene once per camera over a single warm browser
// (SEQUENTIALLY, no concurrency — under SwiftShader renders share the CPU, see
// docs/headless-render.md). These PNGs feed the Opus vision critic in the agent
// loop (PLAN.md step 4).
//
// This module derives NO angles and applies NO presets — cameras are entirely
// caller-controlled — and it re-implements no render logic and re-vendors no
// three.js; all rendering goes through ../headless.
//
// Runtime note: Node loads these .ts sources via on-the-fly type-stripping. A
// relative import of another .ts module resolves at runtime ONLY with an explicit
// ".ts" extension, which tsc rejects as a static import path (TS5097). So the
// *value* exports of ../headless are pulled in via a dynamic import of the opaque
// ".ts" URL (exactly as scripts/render-smoke.mjs does), while the *types* come
// from a type-only import that tsc resolves and the runtime erases.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CameraSpec, CaptureOptions, ViewShot } from "./types";
import type { RenderInput, RenderOptions, RenderResult, RenderStats, Vec3 } from "../headless";

const { renderSceneToPng, launchBrowser, assertNonBlank } = (await import(
  new URL("../headless.ts", import.meta.url).href
)) as {
  renderSceneToPng: (input: RenderInput, options?: RenderOptions) => Promise<RenderResult>;
  launchBrowser: () => Promise<any>;
  assertNonBlank: (stats: RenderStats) => void;
};

/** A CameraSpec after target / direction has been resolved to a single point. */
interface ResolvedCamera {
  name: string;
  camera: { position: Vec3; target: Vec3 };
}

/** A manifest.json view entry written alongside the PNGs. */
interface ManifestView {
  name: string;
  file: string;
  camera: { position: Vec3; target: Vec3 };
  stats: RenderStats;
}

/**
 * Render one PNG per camera by reusing the headless renderer, in input order.
 *
 * Cameras render sequentially over a single browser — reused if `opts.browser`
 * is supplied (and left open), otherwise launched here and closed in a finally.
 * Each caller camera overrides any camera baked into `scene`. With
 * `opts.assertNonBlank !== false`, every frame is checked for blankness and the
 * failure is rethrown with the offending view name prefixed. When `opts.outDir`
 * is set, `<name>.png` per view plus a manifest.json are written there.
 *
 * Throws if `cameras` is empty, if two cameras share a name, or if any camera
 * does not set exactly one of `target` / `direction`.
 */
export async function captureViews(
  scene: RenderInput,
  cameras: CameraSpec[],
  opts: CaptureOptions = {},
): Promise<ViewShot[]> {
  if (cameras.length < 1) {
    throw new Error("captureViews: at least one camera is required (cameras was empty)");
  }
  const resolved = resolveCameras(cameras);

  const ownsBrowser = !opts.browser;
  const browser = opts.browser ?? (await launchBrowser());
  // Constant across cameras. Only forward keys that are actually set:
  // renderSceneToPng merges `{ ...DEFAULTS, ...options }`, so a literal
  // `undefined` would clobber the default rather than fall back to it.
  const renderOptions: RenderOptions = { browser };
  if (opts.width !== undefined) renderOptions.width = opts.width;
  if (opts.height !== undefined) renderOptions.height = opts.height;
  if (opts.clearColor !== undefined) renderOptions.clearColor = opts.clearColor;
  if (opts.timeoutMs !== undefined) renderOptions.timeoutMs = opts.timeoutMs;

  const shots: ViewShot[] = [];
  try {
    for (const cam of resolved) {
      // Caller cameras win: override any camera baked into the scene.
      const input: RenderInput = { ...scene, camera: cam.camera };
      const { png, stats, durationMs } = await renderSceneToPng(input, renderOptions);
      if (opts.assertNonBlank !== false) {
        try {
          assertNonBlank(stats);
        } catch (error) {
          throw new Error(`view "${cam.name}": ${(error as Error).message}`);
        }
      }
      shots.push({ name: cam.name, png, stats, durationMs, camera: cam.camera });
    }
  } finally {
    if (ownsBrowser) {
      await browser.close();
    }
  }

  if (opts.outDir !== undefined) {
    await writeOutputs(opts.outDir, shots);
  }
  return shots;
}

/** Resolve every camera, rejecting duplicate names so output filenames are unique. */
function resolveCameras(cameras: CameraSpec[]): ResolvedCamera[] {
  const seen = new Set<string>();
  return cameras.map((cam) => {
    if (seen.has(cam.name)) {
      throw new Error(`captureViews: duplicate camera name "${cam.name}" (output filenames must be unique)`);
    }
    seen.add(cam.name);
    return { name: cam.name, camera: { position: cam.position, target: resolveTarget(cam) } };
  });
}

/** Resolve a camera's look-at point from exactly one of `target` / `direction`. */
function resolveTarget(cam: CameraSpec): Vec3 {
  const hasTarget = cam.target !== undefined;
  const hasDirection = cam.direction !== undefined;
  if (hasTarget === hasDirection) {
    throw new Error(`camera "${cam.name}": exactly one of target/direction is required`);
  }
  if (cam.target !== undefined) {
    return cam.target;
  }
  // Exactly one is set (guarded above), so direction is defined here. lookAt only
  // uses the ray, so no normalization is needed — target = position + direction.
  const dir = cam.direction as Vec3;
  const [px, py, pz] = cam.position;
  return [px + dir[0], py + dir[1], pz + dir[2]];
}

/** Write one `<name>.png` per view plus a manifest.json into `outDir`. */
async function writeOutputs(outDir: string, shots: ViewShot[]): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const views: ManifestView[] = [];
  for (const shot of shots) {
    const file = `${shot.name}.png`;
    await writeFile(join(outDir, file), shot.png);
    views.push({ name: shot.name, file, camera: shot.camera, stats: shot.stats });
  }
  // Dimensions are identical across views; read the authoritative size from a render.
  const { width, height } = shots[0].stats;
  const manifest = { width, height, views };
  await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}
