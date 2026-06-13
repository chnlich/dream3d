// Pure camera-framing math for the vision critic's multi-angle capture.
//
// criticCameras() returns three cameras that frame the WHOLE scene — a straight-on
// front view plus two three-quarter angles — for the headless multi-angle render
// (src/render/multiangle) that feeds the Claude vision critic in the agent loop.
//
// It reuses the framing STYLE of defaultCameraFraming() in sceneVisuals.js — the
// same elevation and the same horizontal distance from the target — but REPLACES the
// azimuth, orbiting around the Y axis through the target to -35deg / 0 / +35deg so the
// critic judges the layout from several sides instead of a single angle.
//
// This module is imported from Node (the orchestrator), so it MUST stay pure: NO
// "three" import, no rendering — plain arithmetic returning CameraSpec[].

import type { CameraSpec } from "./multiangle/types";

// Azimuths (degrees) around the Y axis: 0 looks straight down +Z (the scene front),
// negative swings to the viewer's left, positive to the viewer's right.
const ANGLES: { name: string; deg: number }[] = [
  { name: "front", deg: 0 },
  { name: "left34", deg: -35 },
  { name: "right34", deg: 35 },
];

export function criticCameras(room: { width: number; depth: number; height: number }): CameraSpec[] {
  const { width, depth, height } = room;
  const span = Math.max(width, depth, height);

  // Same elevation + horizontal distance as defaultCameraFraming(), so the critic's
  // angles match the live viewer's default framing scale; only the azimuth changes.
  const elevation = height * 0.85 + span * 0.35;
  const radius = Math.hypot(width * 0.7, depth * 0.95 + span * 0.2);
  const target: [number, number, number] = [0, height * 0.3, 0];

  return ANGLES.map(({ name, deg }) => {
    const rad = (deg * Math.PI) / 180;
    const position: [number, number, number] = [radius * Math.sin(rad), elevation, radius * Math.cos(rad)];
    return { name, position, target };
  });
}
