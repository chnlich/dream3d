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

// Node-local offset [dx, dy, dz] that seats a fit-normalized model inside its
// approxSize "slot": footprint centered in X/Z, and the model's BASE on the slot
// floor in Y. Inputs are the model's bounding box AFTER the approxSize fit-scale —
// its min corner and its center, both world-space [x, y, z] arrays — plus the slot
// height approxY (= approxSize[1]). The caller then places the pivot at
// transform.position (the slot CENTER, y = approxY/2 for a floor-resting object)
// and scales it by transform.scale, so at scale 1 the model rests exactly on y=0.
//
// Seating the BASE (not the bbox center) in Y is what keeps models on the floor: a
// fitted model shorter than approxY — i.e. whenever Y is NOT the fit-dominant axis,
// which is most flat/wide objects — would otherwise hover by half the height gap.
// X/Z still center so the footprint sits at the planned position. Pure math, no
// THREE dependency, shared by SceneViewer.ts + scene-page.js (kept in lockstep) and
// the floor-rest verification — so the live viewer and the headless critic seat
// every model identically.
export function slotSeatOffset(scaledMin, scaledCenter, approxY) {
  return [-scaledCenter[0], -(scaledMin[1] + approxY / 2), -scaledCenter[2]];
}

// Stand-in material params for an object that is NOT a successfully-loaded GLB, so a
// pending / missing / failed asset still shows in the frame as a clearly-labeled box
// instead of a hole — or, when a load throws, instead of a blanked scene. The two
// states read differently at a glance: a still-working PENDING object is a calm,
// translucent blue ("generating…"), while a FAILED / un-loadable asset is an opaque
// alarm red ("this one broke"). Both renderers (SceneViewer.ts + scene-page.js) import
// these so the live viewer and the headless critic mark a broken asset identically.
// Plain data, no THREE dependency — each renderer feeds it into its own MeshStandardMaterial.
export const STANDIN_PENDING = { color: 0x4dabf7, opacity: 0.85, transparent: true, roughness: 0.6, metalness: 0.05 };
export const STANDIN_FAILED = { color: 0xff5a5a, opacity: 1.0, transparent: false, roughness: 0.5, metalness: 0.0 };

// Pick the stand-in appearance for a scene/schema.ts ObjectStatus. ONLY "failed" reads
// as the red alarm marker; every other non-ready state (pending, or an unknown future
// status) reads as the blue "working" placeholder. A runtime GLB load failure is its own
// case the caller handles by passing STANDIN_FAILED directly.
export function standInAppearance(status) {
  return status === "failed" ? STANDIN_FAILED : STANDIN_PENDING;
}

// Canonical 3/4 front-corner viewing ANGLE for the default camera: the azimuth is
// swung from the +Z scene front toward +X, raised to this elevation above the
// floor. This is the angle the curated demo has always been framed from; what
// changes below is the DISTANCE — now fit to the actual content instead of the room
// box — so a small object (or a tight cluster) fills the frame rather than rendering
// as a distant speck inside an oversized, planner-guessed room.
const VIEW_AZIMUTH_DEG = 37;
const VIEW_ELEVATION_DEG = 27;
// Padding around the subject: the content's bounding sphere spans ~1/FRAMING_MARGIN
// of the vertical FOV, leaving margin on every side (and slack for a non-unit
// viewport aspect and the yaw the axis-aligned content box ignores) so nothing
// kisses the frame edge. 1.3 also happens to reproduce the curated demo's long-
// standing framing distance almost exactly (its content sphere ≈ what the old
// room-box formula framed), so the preset's feel is preserved while oversized,
// content-sparse rooms stop rendering their objects as distant specks.
const FRAMING_MARGIN = 1.3;

// World-space AABB { min, max } that stands in for the room when a scene has no
// objects, so an empty scene still frames the open floor sensibly: centered at the
// origin, spanning the room footprint and rising to the room height.
function roomBounds(room) {
  const { width, depth, height } = room;
  return { min: [-width / 2, 0, -depth / 2], max: [width / 2, height, depth / 2] };
}

// A 3/4 view that frames the scene CONTENT, not the room box. `bounds` is the
// world-space AABB of the placed objects — { min: [x, y, z], max: [x, y, z] }, which
// the caller computes from its own scene graph EXCLUDING the floor/lights — or
// null/omitted for an object-less scene, in which case we fall back to framing the
// room. Pure math: returns plain { position, target } world arrays and touches no
// THREE/camera object, so each renderer applies them to its own camera (and orbit
// controls).
//
// The camera sits along the canonical 3/4 direction at the distance that fits the
// content's bounding SPHERE into the vertical FOV (padded by FRAMING_MARGIN). Fitting
// the sphere — rather than the screen-projected box — keeps the content framed from
// EVERY azimuth, so the live viewer's orbit never swings the subject out of view.
export function defaultCameraFraming(room, bounds) {
  const b = bounds ?? roomBounds(room);
  const center = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const radius = Math.hypot(b.max[0] - center[0], b.max[1] - center[1], b.max[2] - center[2]);
  const halfFov = (CAMERA_FOV * Math.PI) / 180 / 2;
  const distance = (radius / Math.sin(halfFov)) * FRAMING_MARGIN;

  const az = (VIEW_AZIMUTH_DEG * Math.PI) / 180;
  const el = (VIEW_ELEVATION_DEG * Math.PI) / 180;
  // Unit vector from the target toward the camera; +Z is the scene front, +X screen-right.
  const dir = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
  return {
    position: [center[0] + dir[0] * distance, center[1] + dir[1] * distance, center[2] + dir[2] * distance],
    target: center,
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
