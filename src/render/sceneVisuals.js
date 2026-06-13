// Shared three.js "visual recipe" for the dream3d renderers.
//
// The scene lights, the ground (a single open floor plane — no walls), and the
// default 3/4 camera framing are identical between the headless render module
// (src/render/scene-page.js, which runs inside headless Chromium against the
// vendored three.js) and the client viewer (src/viewer/SceneViewer.ts, which
// uses the npm `three` package). This module is the single definition both
// import, so the server-side proof renders and the live viewer stay in lockstep.
//
// It imports ONLY the bare specifier "three" (no addons): on the render page the
// importmap resolves "three" to the vendored build; under the bundler / npm it
// resolves to node_modules/three. Staying addon-free is what lets the exact same
// source run in both worlds.

import * as THREE from "three";

// Background clear color (0xRRGGBB). The headless harness reads its clear color
// from render options instead, so only the client viewer consumes this constant.
export const CLEAR_COLOR = 0x1f262e;

// PerspectiveCamera intrinsics shared by both renderers.
export const CAMERA_FOV = 50;
export const CAMERA_NEAR = 0.1;
export const CAMERA_FAR = 1000;

// Hemisphere ambient + a warm key light + a cool fill. `target` is whatever the
// caller adds scene content to — a Scene in the headless module, a Group in the viewer.
export function addLights(target) {
  target.add(new THREE.HemisphereLight(0xffffff, 0x404654, 1.0));
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(4, 8, 6);
  target.add(key);
  const fill = new THREE.DirectionalLight(0x9fb4ff, 0.4);
  fill.position.set(-6, 4, -3);
  target.add(fill);
}

// Ground is a single flat plane at y=0, centered at the origin — no walls, no
// ceiling. It is sized well beyond the room footprint (~4x width/depth, min
// 40 m/side) so the dark, matte battlefield floor fills the frame as open ground.
export function addRoom(target, room) {
  const { width, depth } = room;

  const groundW = Math.max(width * 4, 40);
  const groundD = Math.max(depth * 4, 40);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(groundW, groundD),
    new THREE.MeshStandardMaterial({ color: 0x2e2a24, roughness: 0.97, metalness: 0.0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  target.add(floor);
}

// A 3/4 view that frames the whole room from a front corner. Pure math: returns
// plain { position, target } world-space arrays and touches no THREE/camera
// object, so each renderer applies them to its own camera (and orbit controls).
export function defaultCameraFraming(room) {
  const { width, depth, height } = room;
  const span = Math.max(width, depth, height);
  return {
    position: [width * 0.7, height * 0.85 + span * 0.35, depth * 0.95 + span * 0.2],
    target: [0, height * 0.3, 0],
  };
}
