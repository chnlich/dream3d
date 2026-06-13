// Types for the multi-angle scene capture module.
//
// captureViews (./index.ts) renders one PNG per caller-supplied camera by reusing
// the merged headless renderer (../headless). Cameras are entirely caller-
// controlled: this module never derives angles or applies presets. The types here
// describe the camera inputs, the per-view results, and the capture options. See
// ./capture-views.mjs for a runnable CLI over these.
//
// `RenderStats` / `Vec3` are imported type-only from ../headless so they are
// erased at runtime (Node loads these .ts sources via on-the-fly type-stripping);
// only ./index.ts actually pulls in headless's value exports.

import type { RenderStats, Vec3 } from "../headless";

/**
 * A single caller-supplied camera. Exactly one of `target` / `direction` must be
 * set: `target` is a world-space look-at point; `direction` is a viewing ray from
 * `position` (resolved to position + direction — no normalization, lookAt only
 * uses the ray). Supplying both or neither is an error (see captureViews).
 */
export interface CameraSpec {
  /** Unique label; also the output PNG filename stem (`<name>.png`). */
  name: string;
  /** World-space camera position [x, y, z]. */
  position: Vec3;
  /** World-space look-at point. Mutually exclusive with `direction`. */
  target?: Vec3;
  /** Viewing direction from `position`. Mutually exclusive with `target`. */
  direction?: Vec3;
}

/** One rendered view: the PNG, its pixel stats, and the concrete camera used. */
export interface ViewShot {
  name: string;
  png: Buffer;
  stats: RenderStats;
  /**
   * Wall-clock render time for this view, in milliseconds (from
   * renderSceneToPng). Carried so a single captureViews call can report per-view
   * timing without re-deriving it (e.g. the CLI's `renderMs` column).
   */
  durationMs: number;
  /** The concrete camera rendered, after resolving target / direction. */
  camera: { position: Vec3; target: Vec3 };
}

/** Options for captureViews. All optional; see the defaults in ./index.ts. */
export interface CaptureOptions {
  width?: number;
  height?: number;
  /** Background / clear color, 0xRRGGBB. */
  clearColor?: number;
  /** Hard per-view render timeout, in milliseconds. */
  timeoutMs?: number;
  /** When set, write `<name>.png` per view plus a manifest.json into this dir. */
  outDir?: string;
  /**
   * An already-launched Playwright Browser to reuse across all views. When
   * provided it is NOT closed by captureViews; otherwise one browser is launched
   * and closed internally.
   */
  browser?: any;
  /** Assert each rendered frame is non-blank (default true). */
  assertNonBlank?: boolean;
}
