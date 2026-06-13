# dream3d — Implementation Plan

**Prompt → multi-object 3D scene generator with an agentic vision-correction loop.**

Built for Claude Build Day (Cerebral Valley × Anthropic, San Francisco, 2026-06-13).
LLM: Claude Opus 4.8 (`claude-opus-4-8`).

---

## 1. What it does

A user types a prompt (e.g. *"a cozy living room with a sofa, a coffee table, a rug, and a person sitting"*). An agent then:

1. decomposes the prompt into a list of objects,
2. generates each object as a GLB asset via the Meshy.ai API,
3. arranges them into a coherent scene,
4. renders the scene, **looks at it** (vision), critiques what is wrong, and fixes it,
5. repeats step 4 until satisfied or **N = 5** passes,
6. presents the result in a web 3D viewer.

The core idea is the **agentic vision-correction loop**: Claude renders the scene, judges it like a human ("the person is floating", "the table overlaps the sofa", "the lamp faces the wall"), and self-corrects. Claude is the brain; Meshy is the asset source.

## 2. Stack

- **Frontend** — Vite + TypeScript + three.js (vanilla), OrbitControls, GLB loading via `GLTFLoader`.
- **Backend** — thin Node + Express server. Holds the Meshy + Anthropic API keys, proxies both, runs the agent orchestration. **Polling** for Meshy job status (no websockets).
- **LLM** — Claude Opus 4.8 (`claude-opus-4-8`) via `@anthropic-ai/sdk`, used for both the **planner** (structured output → scene plan) and the **vision critic** (screenshot + layout JSON → structured issues).

## 3. Agent loop

1. **Plan** — prompt → Opus 4.8 with `output_config.format` (JSON schema) → scene plan:
   `{ room: {w, d, h}, objects: [{ id, label, meshy_prompt, approx_size, placement: {slot | relationship} }] }`.
2. **Generate** — for each object, call Meshy text-to-3D (**preview mode**): submit → poll → download GLB. Cache by `meshy_prompt`. Concurrency-limited submit (≤ 3).
3. **Layout** — place objects by size/slot, normalize scale to declared dimensions, drop to floor, resolve overlaps geometrically.
4. **Review (hybrid)** — front-end captures a canvas screenshot (`renderer.domElement.toDataURL`) and POSTs it back; backend sends screenshot + layout JSON to Opus 4.8 (vision) → structured critique
   `[{ object_id, issue: overlap | floating | wrong_facing | too_big | ..., suggested_fix }]`.
   Geometric checks (overlap / out-of-bounds / floating) run alongside as a cheap guardrail.
5. **Fix** — apply suggested transforms (move / scale / rotate); regenerate an object only if explicitly flagged. Loop 4 → 5 up to **5 passes** or until "satisfied".
6. **Viewer** — final scene JSON → three.js viewer with orbit / pan / zoom.

## 4. Scope (6-hour build)

**In:** prompt → plan → Meshy generation (**cap 4–6 objects**, preview quality) → layout → render → geometric + vision critique → fix loop (≤ 5) → interactive viewer. Room rendered as a primitive box.

**Out (post-demo):** Meshy refine / high-res texturing, advanced materials & lighting, scene save/load, multiple rooms, mobile polish, auth.

## 5. Build sequence (delegated)

- **M1 — Skeleton + end-to-end MOCK mode** (`implement`, reviewed): full stack wired, runnable via `npm run dev` with mock Meshy + mock planner/critic transports — demoable **without keys**. Proves the architecture and is the always-demoable fallback.
- **M2 — Real integration** (`implement`, reviewed): swap mocks for real Opus 4.8 (`@anthropic-ai/sdk`) planner + vision critic, real Meshy text-to-3D, client screenshot capture, caching + concurrency limit. Requires keys.

The repo is already bootstrapped with an initial commit, so there is no separate scaffold step — M1 branches off `main`.

## 6. Keys / config

- API keys live in a gitignored `config/local.json` (config-file over env vars). Required for M2; M1 runs in mock mode without them.
- `.gitignore` must exclude `config/local.json`, `node_modules/`, build output, and any downloaded GLB cache.

## 7. Key risks & mitigations

- **Meshy latency (minutes per asset) — biggest live-demo risk:** preview mode + cache by prompt + object cap + ship a small set of pre-generated fallback GLBs so a Meshy outage cannot kill the demo.
- **Vision-loop latency:** each pass only adjusts transforms (seconds); regenerate an object only when explicitly flagged.
- **Keys not ready:** M1 mock mode keeps progress unblocked.

## 8. Positioning (pitch)

- The differentiator is the **agentic vision-correction loop**, not "we generate 3D" (a crowded space). Claude does the reasoning — decompose → arrange → see → critique → fix; Meshy is just the asset source.
- Target users: indie game devs / AR prototyping, e-commerce 3D, real-estate virtual staging — anyone who needs a coherent multi-object 3D scene from a single sentence.
