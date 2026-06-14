// Client-side interactive three.js viewer: "give a SceneState config, render the whole scene".
//
// The visual recipe (lights / room / default camera framing) lives in the shared module
// src/render/sceneVisuals.js, imported here and by the headless render module
// (src/render/scene-page.js) so the live viewer and the server-side proof renders stay in lockstep.
// sceneVisuals.js imports only the bare "three" specifier; here it resolves to the npm `three`
// package, while on the headless render page an importmap points the same import at the vendored build.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { Room, SceneObject, SceneState, Vec3 } from "../scene/schema";
import {
  addLights,
  addRoom,
  applyAtmosphere,
  defaultCameraFraming,
  slotSeatOffset,
  CAMERA_FOV,
  CAMERA_NEAR,
  CAMERA_FAR,
} from "../render/sceneVisuals.js";

// Stand-in color for objects that are not a ready GLB yet (pending / failed / no url).
const STANDIN_COLOR = 0x4dabf7;

// Crisp full device-pixel-ratio for idle frames, capped at 1.5 so a 2x display doesn't rasterize the
// heavy (~1-2M-triangle) PBR scene at 4x the pixels. While the user orbits/pans/zooms we drop to
// INTERACTION_PIXEL_RATIO (<= 1) so each interaction frame is far cheaper, then restore the full ratio
// once the camera comes to rest. Read once at module load, mirroring the old construction-time read.
const FULL_PIXEL_RATIO = Math.min(window.devicePixelRatio, 1.5);
const INTERACTION_PIXEL_RATIO = Math.min(1, FULL_PIXEL_RATIO);

export class SceneViewer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly resizeObserver: ResizeObserver;
  private contentRoot: THREE.Group | null = null;
  private renderRequested = false;
  private frameHandle: number | null = null;
  // True from the OrbitControls "start" (pointer down) through "end" (release); gates the low-res path.
  private interacting = false;

  constructor(canvas: HTMLCanvasElement) {
    // powerPreference: prefer the discrete GPU on dual-GPU machines. antialias is a construction-time
    // context attribute (cannot be toggled at runtime); preserveDrawingBuffer keeps toDataURL valid.
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // ACES filmic tone mapping rolls the PBR highlights into a cinematic range (the slight exposure
    // bump keeps the dark palette from crushing to black); soft shadow maps let the key light cast.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(FULL_PIXEL_RATIO);

    this.scene = new THREE.Scene();
    // Fog + dark background — the shared battlefield atmosphere, and the scene's only background.
    applyAtmosphere(this.scene);
    // Image-based lighting: a PMREM-prefiltered RoomEnvironment gives the textured PBR materials
    // (metallic/roughness/normal) something to reflect — the single biggest lift from flat to lit.
    // RoomEnvironment is a static box, so generate the env map once here and dispose the generator.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(this.renderer), 0.04).texture;
    pmrem.dispose();

    // FOV / near / far come from the shared visual recipe. Aspect is corrected on first resize.
    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, CAMERA_NEAR, CAMERA_FAR);
    this.camera.position.set(4, 4, 6);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    // On-demand rendering with dynamic resolution: every OrbitControls "change" (orbit/pan/zoom and each
    // damping step) asks for exactly one frame via the idempotent guard — no always-on rAF loop. "start"
    // drops to the cheaper INTERACTION_PIXEL_RATIO so dragging the heavy scene stays smooth; "end" lets the
    // damping tail finish at that low res, then render() restores FULL_PIXEL_RATIO for one final crisp frame.
    this.controls.addEventListener("change", this.requestRender);
    this.controls.addEventListener("start", this.handleControlsStart);
    this.controls.addEventListener("end", this.handleControlsEnd);
    document.addEventListener("visibilitychange", this.handleVisibility);

    this.resizeObserver = new ResizeObserver(this.handleResize);
    this.resizeObserver.observe(canvas);
    this.handleResize();

    this.requestRender();
  }

  async loadScene(scene: SceneState): Promise<void> {
    this.clearContent();

    const root = new THREE.Group();
    root.name = "sceneContent";
    addLights(root);
    addRoom(root, scene.room);

    // One shared GLTFLoader handles concurrent loadAsync calls; load all objects in parallel, then place
    // them in declared order. Promise.all rejects on the first failed ready-GLB load (fail loud).
    const loader = new GLTFLoader();
    const nodes = await Promise.all(scene.objects.map((obj) => this.buildObjectNode(obj, loader)));
    // Union AABB of just the placed OBJECTS (Box3.expandByObject walks each node's
    // world transforms) — NOT the floor/lights — so the default camera frames the
    // actual content and it fills the frame at any object scale.
    const contentBox = new THREE.Box3();
    scene.objects.forEach((obj, i) => {
      const placed = this.normalizeAndPlace(nodes[i], obj);
      this.enableShadows(placed);
      root.add(placed);
      contentBox.expandByObject(placed);
    });

    this.scene.add(root);
    this.contentRoot = root;
    this.frameScene(scene.room, scene.objects.length > 0 ? contentBox : null);
    this.requestRender();
  }

  // Render one frame and read the buffer back. Relies on preserveDrawingBuffer so toDataURL is valid.
  // Force the full pixel ratio first so the capture is always crisp even if invoked mid-interaction
  // (when the renderer is sitting at the lower INTERACTION_PIXEL_RATIO); idempotent when already full.
  captureScreenshot(): string {
    if (this.renderer.getPixelRatio() !== FULL_PIXEL_RATIO) this.applyPixelRatio(FULL_PIXEL_RATIO);
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL("image/png");
  }

  // Override the default framing with an explicit camera position + orbit target (world space).
  setCameraView(position: Vec3, target: Vec3): void {
    this.camera.position.set(position[0], position[1], position[2]);
    this.controls.target.set(target[0], target[1], target[2]);
    this.controls.update();
    this.requestRender();
  }

  dispose(): void {
    if (this.frameHandle !== null) {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    }
    this.controls.removeEventListener("change", this.requestRender);
    this.controls.removeEventListener("start", this.handleControlsStart);
    this.controls.removeEventListener("end", this.handleControlsEnd);
    document.removeEventListener("visibilitychange", this.handleVisibility);
    this.resizeObserver.disconnect();
    this.clearContent();
    this.controls.dispose();
    this.renderer.dispose();
  }

  // --- internals -------------------------------------------------------------

  // rAF callback (three.js "render on demand with damping" pattern). controls.update() returns true while
  // the camera is still moving — live input or the damping tail — and the "change" it fires during that
  // move re-requests the next frame via the idempotent guard, so the chain drives itself and halts once
  // the camera rests. While the pointer is down (interacting) OR the camera is still moving, we hold the
  // cheap INTERACTION_PIXEL_RATIO and pump the next frame, so the whole gesture + damping settle renders
  // at the lower resolution. Once the pointer is released AND update() == false (at rest), if we are still
  // at the interaction ratio we restore FULL_PIXEL_RATIO and render exactly one crisp frame; the chain
  // then stops on its own (no always-on rAF loop).
  private render = (): void => {
    this.renderRequested = false;
    const moving = this.controls.update();
    if (this.interacting || moving) {
      this.renderer.render(this.scene, this.camera);
      this.requestRender();
      return;
    }
    if (this.renderer.getPixelRatio() !== FULL_PIXEL_RATIO) this.applyPixelRatio(FULL_PIXEL_RATIO);
    this.renderer.render(this.scene, this.camera);
  };

  // Idempotent frame request: schedules at most one pending frame, and nothing while the tab is hidden
  // (so a hidden tab burns no frames and any damping tail halts).
  private requestRender = (): void => {
    if (this.renderRequested || document.hidden) return;
    this.renderRequested = true;
    this.frameHandle = requestAnimationFrame(this.render);
  };

  // Repaint once when the tab becomes visible again (frames were suppressed while it was hidden).
  private handleVisibility = (): void => {
    if (!document.hidden) this.requestRender();
  };

  // OrbitControls "start": the user grabbed the scene. Drop to the cheaper interaction resolution so each
  // orbit/pan/zoom frame rasterizes far fewer pixels of the heavy PBR scene, then kick the on-demand loop.
  private handleControlsStart = (): void => {
    this.interacting = true;
    this.applyPixelRatio(INTERACTION_PIXEL_RATIO);
    this.requestRender();
  };

  // OrbitControls "end": pointer released. Clear the flag and let the damping tail keep rendering at the
  // interaction resolution until render() sees controls.update() report the camera at rest and restores
  // the full resolution. The requestRender covers the case where the camera was already at rest.
  private handleControlsEnd = (): void => {
    this.interacting = false;
    this.requestRender();
  };

  // Switch the device-pixel-ratio and resize the drawing buffer to match (updateStyle=false keeps the CSS
  // size fixed, so only the backing buffer shrinks/grows). Called only on the low<->full transitions.
  private applyPixelRatio(ratio: number): void {
    this.renderer.setPixelRatio(ratio);
    const canvas = this.renderer.domElement;
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  }

  private handleResize = (): void => {
    const canvas = this.renderer.domElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  };

  // Ready GLB -> the loaded scene graph; everything else -> a box stand-in sized to approxSize so
  // pending / failed objects still show. A failed load on a ready object throws (fail loud).
  private async buildObjectNode(obj: SceneObject, loader: GLTFLoader): Promise<THREE.Object3D> {
    if (obj.glbUrl && obj.status === "ready") {
      const gltf = await loader.loadAsync(obj.glbUrl);
      return gltf.scene;
    }
    const [w, h, d] = obj.approxSize;
    const material = new THREE.MeshStandardMaterial({
      color: STANDIN_COLOR,
      roughness: 0.6,
      metalness: 0.05,
      transparent: true,
      opacity: 0.85,
    });
    return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  }

  // Normalize a node to approxSize, center its footprint in X/Z and seat its BASE on the floor of the
  // approxSize slot in Y, then apply its transform. transform.position is the object CENTER (scene/schema.ts)
  // and layout.ts sets position.y = approxSize[1]/2, so placing the pivot there (the slot center) with the
  // model's base at the slot floor drops the base onto y=0 at scale 1 — matching layout.ts / geometryCheck.ts
  // / the headless renderer. The pivot wraps the node so yaw spins about the model's vertical axis and
  // transform.scale grows it about its center.
  private normalizeAndPlace(node: THREE.Object3D, obj: SceneObject): THREE.Object3D {
    const approx = new THREE.Vector3(obj.approxSize[0], obj.approxSize[1], obj.approxSize[2]);

    node.updateMatrixWorld(true);
    const preSize = new THREE.Box3().setFromObject(node).getSize(new THREE.Vector3());
    // Uniform fit: divide by the largest size/approx ratio so the model fits within approxSize on every
    // axis (and exactly fills it on the dominant one) — at transform.scale=1 the bbox == approxSize.
    const ratio = Math.max(preSize.x / approx.x, preSize.y / approx.y, preSize.z / approx.z);
    const fit = ratio > 0 ? 1 / ratio : 1;
    node.scale.multiplyScalar(fit);
    node.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(node);
    const center = box.getCenter(new THREE.Vector3());
    // Center the footprint in X/Z, but seat the model's BASE on the floor of its approxSize
    // slot in Y. Centering Y (as before) floated any model shorter than approxSize[1] — i.e.
    // whenever Y is not the fit-dominant axis — by half the height gap. The pivot below sits
    // at transform.position (the slot center, y = approxSize[1]/2 when resting), so the base
    // lands on y=0. Shared with the headless renderer via slotSeatOffset.
    const [dx, dy, dz] = slotSeatOffset([box.min.x, box.min.y, box.min.z], [center.x, center.y, center.z], approx.y);
    node.position.x += dx;
    node.position.y += dy;
    node.position.z += dz;

    const pivot = new THREE.Group();
    pivot.name = obj.id;
    pivot.add(node);
    pivot.position.set(obj.transform.position[0], obj.transform.position[1], obj.transform.position[2]);
    pivot.rotation.y = (obj.transform.rotationYDeg * Math.PI) / 180;
    pivot.scale.setScalar(obj.transform.scale);
    return pivot;
  }

  // Default 3/4 framing from the shared visual recipe, fit to the scene CONTENT (the
  // union AABB of the placed objects) so a small object or a tight cluster fills the
  // frame instead of floating in an oversized room. `contentBox` is null only for an
  // object-less scene, where the framing falls back to the room box.
  private frameScene(room: Room, contentBox: THREE.Box3 | null): void {
    const bounds = contentBox
      ? {
          min: [contentBox.min.x, contentBox.min.y, contentBox.min.z] as [number, number, number],
          max: [contentBox.max.x, contentBox.max.y, contentBox.max.z] as [number, number, number],
        }
      : null;
    const f = defaultCameraFraming(room, bounds);
    this.camera.position.set(...f.position);
    this.controls.target.set(...f.target);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
  }

  private clearContent(): void {
    if (!this.contentRoot) return;
    this.scene.remove(this.contentRoot);
    this.disposeObject(this.contentRoot);
    this.contentRoot = null;
  }

  private disposeObject(root: THREE.Object3D): void {
    root.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) this.disposeMaterial(material);
    });
  }

  private disposeMaterial(material: THREE.Material): void {
    for (const value of Object.values(material)) {
      if (value instanceof THREE.Texture) value.dispose();
    }
    material.dispose();
  }

  // Let every mesh under a placed node both cast and receive shadows, so the units drop shadows onto
  // the floor and onto each other. Called from loadScene's object-add path; kept separate from
  // normalizeAndPlace so the placement/scaling math there stays untouched.
  private enableShadows(root: THREE.Object3D): void {
    root.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.castShadow = true;
      child.receiveShadow = true;
    });
  }
}
