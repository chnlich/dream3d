// Browser-side render module for the headless render harness.
//
// This file runs INSIDE headless Chromium (loaded as an ES module via the
// importmap injected by headless.ts). It is never imported by Node. It reads a
// scene description from `window.__INPUT__`, builds a three.js scene, renders a
// single frame with a software-WebGL renderer, and exposes the result on
// `window` for the Node driver to read:
//   window.__renderState : "running" | "done" | "error"
//   window.__renderError : stack string when state === "error"
//   window.__png         : "data:image/png;base64,..." (canvas.toDataURL)
//   window.__stats       : pixel statistics used to prove the frame is non-blank
//
// We use `preserveDrawingBuffer: true` + `toDataURL` (rather than a Playwright
// element screenshot) because that is exactly the capture path the real dream3d
// viewer uses (see PLAN.md step 4), so this harness exercises the same code.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { addLights, addRoom, defaultCameraFraming, CAMERA_FOV, CAMERA_NEAR, CAMERA_FAR } from "./sceneVisuals.js";

const PALETTE = [0xff6b6b, 0x4dabf7, 0x51cf66, 0xffd43b, 0xcc5de8, 0xff922b];

async function buildAndRender() {
  const input = window.__INPUT__;
  const opts = window.__OPTS__;

  const canvas = document.getElementById("c");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(opts.width, opts.height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(opts.clearColor);

  addLights(scene);
  addRoom(scene, input.room);
  await addObjects(scene, input.objects);

  const camera = makeCamera(input, opts);

  // Render twice across an animation frame so any GLB textures decoded on the
  // first pass are present in the captured frame.
  renderer.render(scene, camera);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  renderer.render(scene, camera);

  window.__png = renderer.domElement.toDataURL("image/png");
  window.__stats = computePixelStats(renderer.domElement, opts.clearColor);
  window.__renderState = "done";
}

async function addObjects(scene, objects) {
  const loader = new GLTFLoader();
  for (let i = 0; i < objects.length; i++) {
    const obj = objects[i];
    let node;
    if (obj.glbUrl) {
      const gltf = await loader.loadAsync(obj.glbUrl);
      node = gltf.scene;
    } else if (obj.primitive === "box") {
      node = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), primitiveMaterial(obj, i));
    } else if (obj.primitive === "cylinder") {
      node = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1, 48), primitiveMaterial(obj, i));
    } else {
      throw new Error(`object[${i}] has neither glbUrl nor a known primitive ("box"|"cylinder")`);
    }
    node.scale.setScalar(obj.scale);
    node.rotation.y = ((obj.rotationYDeg ?? 0) * Math.PI) / 180;
    node.position.set(obj.position[0], obj.position[1], obj.position[2]);
    scene.add(node);
  }
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
window.__png = null;
window.__stats = null;
buildAndRender().catch((error) => {
  window.__renderError = (error && error.stack) || String(error);
  window.__renderState = "error";
});
