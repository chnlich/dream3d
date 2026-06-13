// Browser-side render module for the headless render harness.
//
// This file runs INSIDE headless Chromium (loaded as an ES module via the
// importmap injected by headless.ts). It is never imported by Node. It reads a
// scene description from `window.__INPUT__`, builds a three.js scene ONCE on
// load, and then renders an arbitrary camera angle against that already-loaded
// scene on demand — so a multi-angle capture pays the GLB fetch/parse exactly
// once and each extra angle is a cheap render-only frame.
//
// Contract with the Node driver (src/render/headless.ts):
//   window.__renderState : "running" | "done" | "error"   (flips to done/error
//                          when the scene + every GLB has finished loading)
//   window.__renderError : stack string when state === "error"
//   window.__renderView(camera) : renders the loaded scene from `camera`
//                          ({ position, target }; omit to use the camera baked
//                          into __INPUT__) and returns { png, stats } — the data
//                          URL (canvas.toDataURL) plus the non-blank pixel stats.
//                          It updates ONLY the camera; it never rebuilds the
//                          scene or reloads GLBs.
//
// We use `preserveDrawingBuffer: true` + `toDataURL` (rather than a Playwright
// element screenshot) because that is exactly the capture path the real dream3d
// viewer uses (see PLAN.md step 4), so this harness exercises the same code.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { addLights, addRoom, defaultCameraFraming, CAMERA_FOV, CAMERA_NEAR, CAMERA_FAR } from "./sceneVisuals.js";

// Cache fetched assets (GLB buffers, textures) by URL within this page, so any
// repeat load is served from memory rather than re-fetched/re-decoded.
THREE.Cache.enabled = true;

const PALETTE = [0xff6b6b, 0x4dabf7, 0x51cf66, 0xffd43b, 0xcc5de8, 0xff922b];

// Built once by buildScene() and reused by every __renderView() call. The whole
// point of the session model is that these survive across camera angles.
let renderer = null;
let scene = null;
let camera = null;
let opts = null;

// Build the renderer + scene (lights, room, objects/GLBs) and the initial camera
// EXACTLY ONCE. After this resolves the scene is fully loaded and ready to be
// rendered from any angle by __renderView.
async function buildScene() {
  const input = window.__INPUT__;
  opts = window.__OPTS__;

  const canvas = document.getElementById("c");
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(opts.width, opts.height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(opts.clearColor);

  addLights(scene);
  addRoom(scene, input.room);
  await addObjects(scene, input.objects);

  camera = makeCamera(input, opts);

  // Warm up ONCE: a single render (then cross one animation frame) uploads every
  // GLB texture to the GPU and pays the first-frame cost here, so each later
  // __renderView is a single clean render + capture — no per-view double-render of
  // the (heavy) geometry. This is exactly what the live viewer does (SceneViewer
  // renders via a post-load rAF, then captureScreenshot is a lone render+toDataURL).
  renderer.render(scene, camera);
  await new Promise((resolve) => requestAnimationFrame(resolve));
}

// Render the already-built (and texture-warmed) scene from `cam` (an optional
// { position, target }; when omitted the initial camera from __INPUT__ is used)
// and return the PNG data URL + pixel stats. A single render suffices: textures
// were uploaded during buildScene's warm-up, and preserveDrawingBuffer keeps the
// frame readable by toDataURL (the same lone-render capture SceneViewer uses).
// Updates ONLY the camera: it never rebuilds the scene or reloads GLBs.
window.__renderView = function renderView(cam) {
  if (cam) {
    camera.position.set(cam.position[0], cam.position[1], cam.position[2]);
    camera.lookAt(new THREE.Vector3(cam.target[0], cam.target[1], cam.target[2]));
  }
  renderer.render(scene, camera);
  return {
    png: renderer.domElement.toDataURL("image/png"),
    stats: computePixelStats(renderer.domElement, opts.clearColor),
  };
};

async function addObjects(scene, objects) {
  // One shared GLTFLoader handles concurrent loadAsync calls; build all nodes in
  // PARALLEL, then place them in declared order (mirrors SceneViewer.loadScene).
  // Promise.all rejects on the first failed GLB load (fail loud).
  const loader = new GLTFLoader();
  const nodes = await Promise.all(objects.map((obj, i) => buildObjectNode(obj, loader, i)));
  objects.forEach((obj, i) => {
    const node = nodes[i];
    if (obj.approxSize) {
      placeNormalized(scene, node, obj);
    } else {
      node.scale.setScalar(obj.scale);
      node.rotation.y = ((obj.rotationYDeg ?? 0) * Math.PI) / 180;
      node.position.set(obj.position[0], obj.position[1], obj.position[2]);
      scene.add(node);
    }
  });
}

// Build a single object's node — a loaded GLB scene graph or a built-in primitive
// — WITHOUT placing it (placement runs in declared order after all nodes resolve,
// so parallel loading does not reorder the scene).
async function buildObjectNode(obj, loader, i) {
  if (obj.glbUrl) {
    const gltf = await loader.loadAsync(obj.glbUrl);
    return gltf.scene;
  }
  if (obj.primitive === "box") {
    return new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), primitiveMaterial(obj, i));
  }
  if (obj.primitive === "cylinder") {
    return new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1, 48), primitiveMaterial(obj, i));
  }
  throw new Error(`object[${i}] has neither glbUrl nor a known primitive ("box"|"cylinder")`);
}

// Normalize a node to obj.approxSize and place it on the CENTER convention
// (scene/schema.ts:6 + pipeline/layout.ts: transform.position is the object CENTER,
// floor at y=0). Mirrors SceneViewer.normalizeAndPlace, but recenters the bbox on the
// local origin on ALL THREE axes (NO base-seating, NO floating): the pivot then sits
// at the object CENTER, so the headless critic sees the same scaled, centered model
// the live viewer does.
function placeNormalized(scene, node, obj) {
  const [aw, ah, ad] = obj.approxSize;

  node.updateMatrixWorld(true);
  const preSize = new THREE.Box3().setFromObject(node).getSize(new THREE.Vector3());
  // Uniform fit: divide by the largest size/approx ratio so the model fits within
  // approxSize on every axis (and exactly fills it on the dominant one).
  const fit = 1 / Math.max(preSize.x / aw, preSize.y / ah, preSize.z / ad);
  node.scale.multiplyScalar(fit);
  node.updateMatrixWorld(true);

  const center = new THREE.Box3().setFromObject(node).getCenter(new THREE.Vector3());
  node.position.x -= center.x;
  node.position.y -= center.y;
  node.position.z -= center.z;

  const pivot = new THREE.Group();
  pivot.add(node);
  pivot.scale.setScalar(obj.scale);
  pivot.rotation.y = ((obj.rotationYDeg ?? 0) * Math.PI) / 180;
  pivot.position.set(obj.position[0], obj.position[1], obj.position[2]);
  scene.add(pivot);
}

function primitiveMaterial(obj, index) {
  const color = typeof obj.color === "number" ? obj.color : PALETTE[index % PALETTE.length];
  return new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05 });
}

function makeCamera(input, opts) {
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, opts.width / opts.height, CAMERA_NEAR, CAMERA_FAR);
  if (input.camera) {
    camera.position.set(input.camera.position[0], input.camera.position[1], input.camera.position[2]);
    camera.lookAt(new THREE.Vector3(input.camera.target[0], input.camera.target[1], input.camera.target[2]));
    return camera;
  }
  // Default: a 3/4 view that frames the whole room from a front corner.
  const f = defaultCameraFraming(input.room);
  camera.position.set(...f.position);
  camera.lookAt(new THREE.Vector3(...f.target));
  return camera;
}

// Draw the WebGL canvas onto a 2D canvas and read pixels back so the Node driver
// can prove the frame actually contains rendered content (not a blank fill).
function computePixelStats(glCanvas, clearColorHex) {
  const c = document.createElement("canvas");
  c.width = glCanvas.width;
  c.height = glCanvas.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(glCanvas, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  const total = width * height;

  const bg = { r: (clearColorHex >> 16) & 255, g: (clearColorHex >> 8) & 255, b: clearColorHex & 255 };
  const distinct = new Set();
  let sum = 0;
  let sumSq = 0;
  let nonBackground = 0;
  for (let p = 0; p < data.length; p += 4) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    sum += luminance;
    sumSq += luminance * luminance;
    // Quantize to 5 bits per channel to keep the set bounded but meaningful.
    distinct.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
    if (Math.abs(r - bg.r) + Math.abs(g - bg.g) + Math.abs(b - bg.b) > 24) {
      nonBackground++;
    }
  }
  const mean = sum / total;
  const variance = sumSq / total - mean * mean;
  return {
    width,
    height,
    distinctColors: distinct.size,
    nonBackgroundFraction: nonBackground / total,
    meanLuminance: mean,
    luminanceStdDev: Math.sqrt(Math.max(0, variance)),
  };
}

window.__renderState = "running";
window.__renderError = null;
// Build the scene exactly once. The Node driver waits for state === "done" before
// calling __renderView, so the first view never races an unfinished scene/GLB load.
buildScene()
  .then(() => {
    window.__renderState = "done";
  })
  .catch((error) => {
    window.__renderError = (error && error.stack) || String(error);
    window.__renderState = "error";
  });
