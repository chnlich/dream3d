// Demo entry for viewer.html: mount the interactive SceneViewer on the full-viewport canvas and
// load the hand-authored sample scene.
import { SceneViewer } from "./viewer/SceneViewer";
import { sampleScene } from "./viewer/sampleScene";

const canvas = document.getElementById("viewer");
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error("#viewer canvas missing from viewer.html");
}

const viewer = new SceneViewer(canvas);
await viewer.loadScene(sampleScene);
