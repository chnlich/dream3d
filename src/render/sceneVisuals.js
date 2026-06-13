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

// The dark, moody battlefield clear/background color (0xRRGGBB). applyAtmosphere() paints both the
// scene background and the exponential fog with it, so the open ground dissolves into a murky
// horizon, and the client viewer uses it as its background. The headless harness reads its own
// clear color from render options instead.
export const CLEAR_COLOR = 0x0b0e12;

// PerspectiveCamera intrinsics shared by both renderers.
export const CAMERA_FOV = 50;
export const CAMERA_NEAR = 0.1;
export const CAMERA_FAR = 1000;

// A dramatic three-light rig for the dark battlefield: a dim hemisphere for just enough ambient
// lift, a strong warm key from the front-right that casts the scene's shadows, and a cool blue rim
// from behind-above to pop the creature silhouettes out of the murky background. `target` is
// whatever the caller adds scene content to — a Scene in the headless module, a Group in the viewer.
export function addLights(target) {
  target.add(new THREE.HemisphereLight(0xffffff, 0x404654, 0.3));

  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(4, 8, 6);
  // The key is the sole shadow caster. Size its orthographic shadow frustum to comfortably contain
  // the unit cluster around the origin (the room is 8x6) and give it a crisp 2k shadow map. Shadows
  // only render when the renderer enables shadowMap — the client viewer does, the headless harness
  // does not, so these settings are a harmless no-op there.
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 40;
  key.shadow.camera.left = -12;
  key.shadow.camera.right = 12;
  key.shadow.camera.top = 12;
  key.shadow.camera.bottom = -12;
  target.add(key);

  const rim = new THREE.DirectionalLight(0x77bbff, 1.1);
  rim.position.set(-5, 7, -9);
  target.add(rim);
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
    new THREE.MeshStandardMaterial({ color: 0x26221c, roughness: 0.97, metalness: 0.0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
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

// Wrap the scene in the battlefield atmosphere: exponential distance fog plus a matching solid
// background, both in CLEAR_COLOR, so distant geometry fades into a murky horizon. These live on the
// Scene itself (fog and background are Scene-level), unlike addLights/addRoom which decorate the
// content group the caller passes them.
export function applyAtmosphere(scene) {
  scene.fog = new THREE.FogExp2(CLEAR_COLOR, 0.02);
  scene.background = new THREE.Color(CLEAR_COLOR);
}
