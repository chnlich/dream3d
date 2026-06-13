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
      meshyPrompt:
        "bulky armored humanoid soldier in heavy powered exosuit, full enclosed helmet, thick shoulder pauldrons, both hands gripping a short chunky rifle, standing upright",
      approxSize: [1.21, 2.0, 1.02],
      transform: { position: [-1.8, 0, 0.5], rotationYDeg: 25, scale: 1 },
      glbUrl: "/sample-assets/marine.glb",
      status: "ready",
    },
    {
      id: "zergling",
      label: "Zerg Zergling",
      meshyPrompt:
        "small fast four-legged carapaced alien beast, two scythe-like clawed forelimbs, low crouched predatory posture, segmented chitin plates",
      approxSize: [1.96, 1.0, 1.87],
      transform: { position: [1.5, 0, -0.5], rotationYDeg: -120, scale: 1 },
      glbUrl: "/sample-assets/zergling.glb",
      status: "ready",
    },
    {
      id: "hydralisk",
      label: "Zerg Hydralisk",
      meshyPrompt:
        "tall serpentine alien creature with an armored hooded head, upright cobra-like raised torso, a pair of large bladed scythe forelimbs, segmented carapace",
      approxSize: [1.6, 2.6, 1.6],
      transform: { position: [0.2, 0, -2.0], rotationYDeg: 180, scale: 1 },
      glbUrl: "/sample-assets/hydralisk.glb",
      status: "ready",
    },
  ],
};
