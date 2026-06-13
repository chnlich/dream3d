import type { SceneState } from "../scene/schema";

// Hand-authored demo scene: three StarCraft units standing in a small room, roughly facing the
// center and spaced so their bounding boxes don't overlap. GLBs live under public/sample-assets/
// (gitignored; regenerate via scripts/meshy-generate.mjs). approxSize drives the bbox normalization.
export const sampleScene: SceneState = {
  room: { width: 8, depth: 6, height: 3.5 },
  pass: 0,
  objects: [
    {
      id: "marine",
      label: "Terran Marine",
      meshyPrompt: "",
      approxSize: [0.9, 2.0, 0.9],
      transform: { position: [-1.8, 0, 0.5], rotationYDeg: 25, scale: 1 },
      glbUrl: "/sample-assets/marine.glb",
      status: "ready",
    },
    {
      id: "zergling",
      label: "Zerg Zergling",
      meshyPrompt: "",
      approxSize: [1.4, 1.0, 1.8],
      transform: { position: [1.5, 0, -0.5], rotationYDeg: -120, scale: 1 },
      glbUrl: "/sample-assets/zergling.glb",
      status: "ready",
    },
    {
      id: "hydralisk",
      label: "Zerg Hydralisk",
      meshyPrompt: "",
      approxSize: [1.6, 2.6, 1.6],
      transform: { position: [0.2, 0, -2.0], rotationYDeg: 180, scale: 1 },
      glbUrl: "/sample-assets/hydralisk.glb",
      status: "ready",
    },
  ],
};
