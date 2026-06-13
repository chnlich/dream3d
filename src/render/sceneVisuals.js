// Shared three.js "visual recipe" for the dream3d renderers.
//
// The scene lights, the room (floor + back/left walls), and the default 3/4
// camera framing are identical between the headless render module
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

// Room mirrors a box open toward the camera: floor flat at y=0, back wall at
// z=-depth/2, left wall at x=-width/2 — centered at the origin.
export function addRoom(target, room) {
  const { width, depth, height } = room;

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(width, depth),
    new THREE.MeshStandardMaterial({ color: 0x8b939e, roughness: 0.95, metalness: 0.0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  target.add(floor);

  const wallMat = new THREE.MeshStandardMaterial({ color: 0xd7dde4, roughness: 1.0, side: THREE.DoubleSide });

  const back = new THREE.Mesh(new THREE.PlaneGeometry(width, height), wallMat);
  back.position.set(0, height / 2, -depth / 2);
  target.add(back);

  const left = new THREE.Mesh(new THREE.PlaneGeometry(depth, height), wallMat);
  left.rotation.y = Math.PI / 2;
  left.position.set(-width / 2, height / 2, 0);
  target.add(left);
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
