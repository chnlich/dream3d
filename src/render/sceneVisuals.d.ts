// Type declarations for the plain-JS shared visual recipe (sceneVisuals.js).
// allowJs is off, so TypeScript consumers (src/viewer/SceneViewer.ts) resolve
// the "./sceneVisuals.js" import to these declarations. Kept in lockstep with
// sceneVisuals.js by hand.

import type { Object3D, Scene } from "three";

/** Room dimensions in world units (X / Z / Y). Structurally matches scene/schema Room. */
export interface RoomDims {
  width: number;
  depth: number;
  height: number;
}

/** A default camera framing as plain world-space arrays (spreadable into Vector3.set). */
export interface CameraFraming {
  position: [number, number, number];
  target: [number, number, number];
}

/** A world-space axis-aligned bounding box as plain arrays (min/max corners). */
export interface ContentBounds {
  min: [number, number, number];
  max: [number, number, number];
}

export const CLEAR_COLOR: number;
export const CAMERA_FOV: number;
export const CAMERA_NEAR: number;
export const CAMERA_FAR: number;

export function addLights(target: Object3D): void;
export function addRoom(target: Object3D, room: RoomDims): void;

/**
 * Node-local offset [dx, dy, dz] that seats a fit-normalized model in its approxSize
 * slot: footprint centered in X/Z, base on the slot floor in Y. `scaledMin`/`scaledCenter`
 * are the model's post-fit bounding-box min corner + center; `approxY` is the slot height
 * (approxSize[1]). Seating the base (not the center) in Y is what keeps models from floating.
 */
export function slotSeatOffset(
  scaledMin: [number, number, number],
  scaledCenter: [number, number, number],
  approxY: number,
): [number, number, number];

/**
 * Default 3/4 framing for the viewer/headless default camera. Frames the scene
 * CONTENT when `bounds` (the placed objects' world AABB, floor excluded) is given,
 * otherwise falls back to framing the `room` box. Pure; returns spreadable arrays.
 */
export function defaultCameraFraming(room: RoomDims, bounds?: ContentBounds | null): CameraFraming;

/** Set Scene-level fog + background (the shared battlefield atmosphere). Client-viewer use. */
export function applyAtmosphere(scene: Scene): void;
