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
import type { Room, SceneObject, SceneState, Vec3 } from "../scene/schema";
import {
  addLights,
  addRoom,
  defaultCameraFraming,
  CLEAR_COLOR,
  CAMERA_FOV,
  CAMERA_NEAR,
  CAMERA_FAR,
} from "../render/sceneVisuals.js";

// Stand-in color for objects that are not a ready GLB yet (pending / failed / no url).
const STANDIN_COLOR = 0x4dabf7;

export class SceneViewer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly resizeObserver: ResizeObserver;
  private contentRoot: THREE.Group | null = null;
  private renderRequested = false;
  private frameHandle: number | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(CLEAR_COLOR);

    // FOV / near / far come from the shared visual recipe. Aspect is corrected on first resize.
    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, CAMERA_NEAR, CAMERA_FAR);
    this.camera.position.set(4, 4, 6);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    // On-demand rendering: every OrbitControls "change" (orbit/pan/zoom and each damping step) asks for
    // exactly one frame via the idempotent guard, so there is no always-on rAF loop.
    this.controls.addEventListener("change", this.requestRender);
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
    scene.objects.forEach((obj, i) => root.add(this.normalizeAndPlace(nodes[i], obj)));

    this.scene.add(root);
    this.contentRoot = root;
    this.frameRoom(scene.room);
    this.requestRender();
  }

  // Render one frame and read the buffer back. Relies on preserveDrawingBuffer so toDataURL is valid.
  captureScreenshot(): string {
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
    document.removeEventListener("visibilitychange", this.handleVisibility);
    this.resizeObserver.disconnect();
    this.clearContent();
    this.controls.dispose();
    this.renderer.dispose();
  }

  // --- internals -------------------------------------------------------------

  // rAF callback (three.js "render on demand with damping" pattern): clear the flag first so a
  // damping-driven "change" fired during controls.update() re-requests the next frame — that chain
  // drives the damping settle and stops on its own once the camera comes to rest.
  private render = (): void => {
    this.renderRequested = false;
    this.controls.update();
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

  // Normalize a node to approxSize, center its bbox on the pivot origin (all three axes), then apply its
  // transform. transform.position is the object CENTER (scene/schema.ts), so seating the bbox center at
  // the pivot origin and placing the pivot there drops the base onto the floor — at scale 1, position.y
  // is the half-height — matching layout.ts / geometryCheck.ts / the headless renderer. The pivot wraps
  // the node so yaw spins about the model's vertical axis and transform.scale grows it about its center.
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
    node.position.x -= center.x;
    node.position.z -= center.z;
    node.position.y -= center.y;

    const pivot = new THREE.Group();
    pivot.name = obj.id;
    pivot.add(node);
    pivot.position.set(obj.transform.position[0], obj.transform.position[1], obj.transform.position[2]);
    pivot.rotation.y = (obj.transform.rotationYDeg * Math.PI) / 180;
    pivot.scale.setScalar(obj.transform.scale);
    return pivot;
  }

  // Default 3/4 framing from the shared visual recipe; apply to the camera + orbit target.
  private frameRoom(room: Room): void {
    const f = defaultCameraFraming(room);
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
}
