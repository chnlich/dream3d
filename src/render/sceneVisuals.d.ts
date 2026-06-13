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

export const CLEAR_COLOR: number;
export const CAMERA_FOV: number;
export const CAMERA_NEAR: number;
export const CAMERA_FAR: number;

export function addLights(target: Object3D): void;
export function addRoom(target: Object3D, room: RoomDims): void;
export function defaultCameraFraming(room: RoomDims): CameraFraming;

/** Set Scene-level fog + background (the shared battlefield atmosphere). Client-viewer use. */
export function applyAtmosphere(scene: Scene): void;
