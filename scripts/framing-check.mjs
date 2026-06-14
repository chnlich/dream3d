#!/usr/bin/env node
// Default-camera framing verification for the content-fit framing change.
//
// The default camera (live viewer SceneViewer.frameScene + headless scene-page
// makeCamera, both via the shared defaultCameraFraming() in sceneVisuals.js) used to
// frame the ROOM box, computed purely from planner-guessed room dims. A planner
// routinely guesses a room far larger than the actual content, so a small object — or
// a tight cluster — rendered as a distant speck in an oversized empty room. The fix
// frames the CONTENT (the union AABB of the placed objects): the camera sits along
// the same canonical 3/4 angle, but at the distance that fits the content's bounding
// sphere into the FOV, so the subject fills the frame regardless of the room guess.
//
// This proves the change with NO Meshy credits and NO LLM calls:
//   1. PURE MATH on the production defaultCameraFraming():
//      - frames the CONTENT, not the room: identical framing for the same content in
//        two wildly different rooms; target == content center; canonical 3/4 angle.
//      - the content's bounding sphere lands well inside the FOV (no clipping) yet
//        fills a healthy fraction of it (not a speck).
//      - big-room win: for a small object in an oversized room, the content-fit
//        camera is many times closer than the old room-box framing (the null-bounds
//        fallback, which still frames the room).
//   2. HEADLESS RENDER (committed tiny-box.glb): the same small-object-in-a-big-room
//      scene rendered with the content-fit default vs the OLD room-box camera —
//      content-fit fills far more of the frame (and the old camera renders it nearly
//      blank). Plus, if the pinned StarCraft GLBs are present, the curated demo scene
//      stays well-framed (non-blank, healthy fill) under the content-fit default.
//
// Run:  node scripts/framing-check.mjs
// Exits non-zero on any failed assertion.

import { existsSync } from "node:fs";

const SC_DIR = "/tmp/sc-demo";
const TINY_BOX = new URL("./.assets/tiny-box.glb", import.meta.url).pathname;

// The production framing math + intrinsics (pure functions; sceneVisuals.js imports
// "three" but defaultCameraFraming touches no THREE object — same import floor-rest-check uses).
const { defaultCameraFraming, CAMERA_FOV } = await import(new URL("../src/render/sceneVisuals.js", import.meta.url).href);
// The headless render harness (Node strips the .ts types on the fly).
const { renderSceneToPng, launchBrowser } = await import(new URL("../src/render/headless.ts", import.meta.url).href);

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const DEG = Math.PI / 180;

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function len(v) {
  return Math.hypot(v[0], v[1], v[2]);
}
function centerOf(b) {
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
}
function radiusOf(b) {
  const c = centerOf(b);
  return Math.hypot(b.max[0] - c[0], b.max[1] - c[1], b.max[2] - c[2]);
}
// The OLD framing: the room-box formula defaultCameraFraming used before content-fit.
// Used here to render the "before" comparison and as the documented baseline.
function oldRoomFraming(room) {
  const { width, depth, height } = room;
  const span = Math.max(width, depth, height);
  return {
    position: [width * 0.7, height * 0.85 + span * 0.35, depth * 0.95 + span * 0.2],
    target: [0, height * 0.3, 0],
  };
}

// --- 1. PURE MATH ----------------------------------------------------------
console.log("1. Pure-math framing (production defaultCameraFraming):\n");

// A small object resting at the origin, and the SAME object framed in two very
// different rooms. Content-fit must ignore the room entirely.
const smallBounds = { min: [-0.3, 0, -0.3], max: [0.3, 0.6, 0.3] };
const tinyRoom = { width: 2, depth: 2, height: 2.5 };
const hugeRoom = { width: 30, depth: 24, height: 8 };

const fitTiny = defaultCameraFraming(tinyRoom, smallBounds);
const fitHuge = defaultCameraFraming(hugeRoom, smallBounds);

const sameFraming =
  len(sub(fitTiny.position, fitHuge.position)) < 1e-9 && len(sub(fitTiny.target, fitHuge.target)) < 1e-9;
check("frames the CONTENT, not the room (identical framing in a 2m vs a 30m room)", sameFraming,
  `|Δposition|=${len(sub(fitTiny.position, fitHuge.position)).toExponential(1)}`);

const c = centerOf(smallBounds);
check("target == content center", len(sub(fitHuge.target, c)) < 1e-9,
  `target=[${fitHuge.target.map((n) => n.toFixed(3)).join(", ")}] center=[${c.map((n) => n.toFixed(3)).join(", ")}]`);

// Canonical 3/4 angle: above the target, in front (+Z), to the right (+X).
const rel = sub(fitHuge.position, fitHuge.target);
const elevationDeg = Math.asin(rel[1] / len(rel)) / DEG;
const azimuthDeg = Math.atan2(rel[0], rel[2]) / DEG; // from +Z toward +X
check("canonical 3/4 angle (front-right, raised ~27°)",
  rel[0] > 0 && rel[2] > 0 && Math.abs(elevationDeg - 27) < 0.5 && Math.abs(azimuthDeg - 37) < 0.5,
  `azimuth=${azimuthDeg.toFixed(1)}° elevation=${elevationDeg.toFixed(1)}°`);

// The content's bounding sphere fits inside the vertical FOV (no clipping) but is not
// a speck: its angular DIAMETER should be a healthy chunk of the FOV.
const sphereAngularDiamDeg = (2 * Math.asin(radiusOf(smallBounds) / len(rel))) / DEG;
check("content sphere fits within the FOV (no clipping)", sphereAngularDiamDeg < CAMERA_FOV,
  `sphere subtends ${sphereAngularDiamDeg.toFixed(1)}° of the ${CAMERA_FOV}° FOV`);
check("content fills a healthy fraction of the FOV (not a speck)", sphereAngularDiamDeg > CAMERA_FOV * 0.5,
  `${((sphereAngularDiamDeg / CAMERA_FOV) * 100).toFixed(0)}% of the FOV`);

// Big-room win: the content-fit camera vs the room-box fallback (null bounds == the
// OLD behavior) for the SAME small object in a huge room.
const distFit = len(sub(defaultCameraFraming(hugeRoom, smallBounds).position, centerOf(smallBounds)));
const roomFallback = defaultCameraFraming(hugeRoom, null);
const distRoom = len(sub(roomFallback.position, roomFallback.target));
check("big-room win: content-fit camera is many× closer than the old room-box framing",
  distFit < distRoom / 5,
  `content-fit dist=${distFit.toFixed(2)} m vs room-box dist=${distRoom.toFixed(2)} m (${(distRoom / distFit).toFixed(1)}× closer)`);

// --- 2. HEADLESS RENDER ----------------------------------------------------
console.log("\n2. Headless render (content-fit default vs the old room-box camera):\n");

const browser = await launchBrowser();
try {
  // A small object inside an oversized, content-sparse room (the planner-over-guess
  // case). approxSize drives the render-page normalization; position rests it on y=0.
  const bigRoom = { width: 24, depth: 18, height: 7 };
  const approx = [0.6, 0.6, 0.6];
  const smallObjScene = (camera) => ({
    room: bigRoom,
    objects: [{ glbUrl: TINY_BOX, position: [0, approx[1] / 2, 0], rotationYDeg: 25, scale: 1, approxSize: approx }],
    ...(camera ? { camera } : {}),
  });

  // The old room camera also frames a huge floor plane, whose dark color differs from
  // the clear color and so counts toward nonBackgroundFraction. To isolate the OBJECT,
  // render the same old-camera view with NO object (floor only) and subtract: under the
  // old framing the object barely moves the needle (a speck), while the content-fit
  // default makes the object dominate the frame.
  const fit = await renderSceneToPng(smallObjScene(null), { browser });
  const old = await renderSceneToPng(smallObjScene(oldRoomFraming(bigRoom)), { browser });
  const oldFloor = await renderSceneToPng(
    { room: bigRoom, objects: [], camera: oldRoomFraming(bigRoom) },
    { browser },
  );
  const fitPct = fit.stats.nonBackgroundFraction;
  const oldPct = old.stats.nonBackgroundFraction;
  const oldObjContrib = oldPct - oldFloor.stats.nonBackgroundFraction; // object's own share under old framing
  console.log(`  small object in a ${bigRoom.width}×${bigRoom.depth}×${bigRoom.height} m room:`);
  console.log(`    content-fit default : ${(fitPct * 100).toFixed(1)}% of frame non-background`);
  console.log(`    old room-box camera : ${(oldPct * 100).toFixed(1)}% non-background, of which the object is only ${(oldObjContrib * 100).toFixed(2)}% (rest is floor)`);
  check("content-fit fills far more of the frame than the old room-box camera", fitPct > oldPct * 3,
    `${(fitPct / Math.max(oldPct, 1e-6)).toFixed(1)}× more`);
  check("content-fit frames the object prominently (>10% of frame)", fitPct > 0.1, `${(fitPct * 100).toFixed(1)}%`);
  check("old room-box framing rendered the object as a speck (<1% of frame, the bug)", oldObjContrib < 0.01,
    `object = ${(oldObjContrib * 100).toFixed(2)}% of frame`);

  // The curated StarCraft demo must stay well-framed under the content-fit default.
  const scGlbs = ["marine", "zergling", "hydralisk"].map((n) => `${SC_DIR}/${n}.glb`);
  if (scGlbs.every((p) => existsSync(p))) {
    const scScene = (camera) => ({
      room: { width: 8, depth: 6, height: 3.5 },
      objects: [
        { glbUrl: scGlbs[0], position: [-1.8, 1.0, 0.5], rotationYDeg: 25, scale: 1, approxSize: [1.21, 2.0, 1.02] },
        { glbUrl: scGlbs[1], position: [1.5, 0.5, -0.5], rotationYDeg: -120, scale: 1, approxSize: [1.96, 1.0, 1.87] },
        { glbUrl: scGlbs[2], position: [0.2, 1.3, -2.0], rotationYDeg: 180, scale: 1, approxSize: [1.6, 2.6, 1.6] },
      ],
      ...(camera ? { camera } : {}),
    });
    const scFit = await renderSceneToPng(scScene(null), { browser });
    const scOld = await renderSceneToPng(scScene(oldRoomFraming({ width: 8, depth: 6, height: 3.5 })), { browser });
    console.log(`\n  curated StarCraft demo (3 units, 8×6×3.5 m room):`);
    console.log(`    content-fit default : ${(scFit.stats.nonBackgroundFraction * 100).toFixed(1)}% fill, ${scFit.stats.distinctColors} colors`);
    console.log(`    old room-box camera : ${(scOld.stats.nonBackgroundFraction * 100).toFixed(1)}% fill, ${scOld.stats.distinctColors} colors`);
    check("SC demo stays well-framed under content-fit (non-blank, healthy fill)",
      scFit.stats.nonBackgroundFraction > 0.08 && scFit.stats.distinctColors > 16 && scFit.stats.luminanceStdDev > 4,
      `${(scFit.stats.nonBackgroundFraction * 100).toFixed(1)}% fill, stddev ${scFit.stats.luminanceStdDev.toFixed(1)}`);
  } else {
    console.log(`\n  SKIP — pinned StarCraft GLBs not present under ${SC_DIR} (small-object render proof stands)`);
  }
} finally {
  await browser.close();
}

console.log("");
if (failures > 0) {
  console.error(`FAIL — ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("PASS — the default camera frames the scene CONTENT, so objects fill the frame at any room size");
