# dream3d

Turn a one-line prompt into a coherent, multi-object 3D scene — then let an agent
**look at the render and correct what's wrong**.

Built for **Claude Build Day** (Cerebral Valley × Anthropic, San Francisco,
2026-06-13). Claude is the brain (plan → see → critique → fix);
[Meshy.ai](https://www.meshy.ai/) is the asset source.

## What it is

You type something like *"a cozy living room with a sofa, a coffee table and a
floor lamp"*. dream3d decomposes it into objects, generates each as a textured 3D
model, arranges them in a room, then runs an **agentic vision-correction loop**:
it renders the scene from several angles, judges it the way a person would ("the
lamp is floating", "the table overlaps the sofa"), and self-corrects — repeating
for as many amend rounds as you ask for.

The differentiator is that loop. Generating 3D is a crowded space; here Claude
does the reasoning (decompose → arrange → see → critique → fix) and Meshy is just
where the meshes come from.

## How it works

The pipeline lives in [`src/pipeline/orchestrator.ts`](src/pipeline/orchestrator.ts) —
`generate(prompt, amendRounds, mode, onEvent?)`:

```
prompt
  │
  ▼
1. Plan     claudePlanner → ScenePlan: a room + 3–6 objects, each with a
  │         meshyPrompt, approxSize, position and rotationYDeg.
  ▼
2. Assets   meshyAssetProvider generates each object via Meshy preview → refine
  │         → a TEXTURED PBR GLB (≤ 300k tris). ≤ 3 concurrent. Cached.
  ▼
3. Layout   layout() drops objects onto the floor (position = object CENTER) and
  │         deterministically separates overlapping footprints.
  ▼
4. Amend ×N render the scene from several critic camera angles (captureViews),
  │         collect issues from geometryCheck (floating / out_of_bounds /
  │         overlap) + claudeVisionCritic (vision), then apply fix().
  │         ONE warm headless browser is reused across every round.
  ▼
{ passes }  amendRounds + 1 passes: the draft (p0), then one per amend round.
```

### Mock vs real mode

- **Mock (default)** — fully offline, no keys, instant. Mock planner / asset /
  critic exercise the whole pipeline and pass structure without any network.
- **Real** — `DREAM3D_MODE=real` drives the real Claude + Meshy pipeline
  (`resolveMode()` in the orchestrator).

## Quick start

```bash
npm install
npm run dev            # Vite dev server on http://localhost:5173
```

Open **http://localhost:5173/studio.html**. With no keys this runs the offline
mock pipeline end-to-end.

For the **real** pipeline (Claude + Meshy):

```bash
bash scripts/setup-headless-render.sh          # one-shot, no-sudo headless-render host setup
cp config/local.example.json config/local.json # then add your Meshy key (see below)
DREAM3D_MODE=real npm run dev
```

Real mode also needs the local `claude` CLI logged in (see **LLM transport**).

## Pages

Vite multi-page app — entries are declared in [`vite.config.ts`](vite.config.ts):

- **`studio.html`** ([`src/studioMain.ts`](src/studioMain.ts)) — the main app:
  prompt + preset dropdown + amend-rounds input → **Generate** → a live progress
  log (polled from the job API) → a 3D `SceneViewer` with a Prev/Next pass
  stepper and an object list.
- **`viewer.html`** ([`src/viewerMain.ts`](src/viewerMain.ts)) — an interactive
  viewer of a pinned sample scene ([`src/viewer/sampleScene.ts`](src/viewer/sampleScene.ts)).
  Its GLBs live under `public/sample-assets/` (gitignored; regenerate with
  `scripts/meshy-generate.mjs`).
- **`index.html`** ([`src/main.ts`](src/main.ts)) — a minimal dev stub.

## Backend

A **Vite dev-middleware plugin** (not Express),
[`src/server/apiPlugin.ts`](src/server/apiPlugin.ts). A real run is minute-scale,
so it uses a job model:

| Method & path | Result |
|---|---|
| `POST /api/generate` `{ prompt, amendRounds }` | `202 { jobId }` — starts a background run |
| `GET /api/generate/<jobId>` | `JobStatus` — poll for the live progress log + final `passes` |
| `GET /assets/<id>.glb` | static GLB from `~/.cache/dream3d/assets` |

## LLM transport

The planner and the vision critic call the already-authenticated **local `claude`
CLI**, headlessly — there is **no Anthropic SDK and no API key**. See
[`src/llm/claudeCli.ts`](src/llm/claudeCli.ts):

```
claude -p <prompt> --model claude-opus-4-8 --output-format json
```

(run with `--permission-mode bypassPermissions`; image inputs are passed by path
to the `Read` tool). `config/local.json` holds **only** `meshyApiKey`.

## Configuration & env vars

- **`config/local.json`** — `{ "meshyApiKey": "msy_..." }`, gitignored. Copy from
  [`config/local.example.json`](config/local.example.json). Needed only for real
  Meshy generation; a pure cache hit needs no key.
- **`DREAM3D_MODE`** — `real` to use the Claude + Meshy pipeline; anything else =
  mock (default).
- **`DREAM3D_RESPONSE_CACHE=0`** — bypass the response cache (real mode).
- **`DREAM3D_PLAN_CACHE=0`** — bypass the plan cache (real mode).
- The dev server pins port **5173** (`strictPort`) and allow-lists a Tailscale
  Funnel hostname for public HTTPS exposure — see `server.allowedHosts` in
  [`vite.config.ts`](vite.config.ts).

## Caching

Three layers, all **real-mode only** (mock always runs fresh):

1. **Response cache** ([`src/pipeline/responseCache.ts`](src/pipeline/responseCache.ts))
   — memoizes the whole `GenerateResponse` by `(prompt, amendRounds, mode)`. A
   repeat is sub-second and spends zero Meshy credits.
2. **Plan cache** ([`src/pipeline/planCache.ts`](src/pipeline/planCache.ts)) —
   caches the planner's `ScenePlan` by `(prompt, mode)`. `amendRounds` is
   excluded, so re-running the same prompt reuses the plan — identical
   `meshyPrompt`s → Meshy asset-cache hits.
3. **Meshy asset cache** ([`src/meshy/cache.mjs`](src/meshy/cache.mjs); dir
   `~/.cache/dream3d/meshy/`) — caches each GLB by `(prompt, mode,
   generation-param signature)`. Shared by the pipeline provider **and**
   `scripts/meshy-generate.mjs`. The param signature comes from
   [`src/meshy/genParams.mjs`](src/meshy/genParams.mjs) (the single source of the
   preview/refine submit params: `target_polycount` 300000, `ai_model` meshy-6,
   PBR, …), so changing any param yields a new key.

## Project layout

```
src/
  pipeline/   orchestrator + planner/asset/critic (real + mock), layout,
              geometryCheck, fix, response & plan caches, shared types
  llm/        headless `claude` CLI transport (claudeCli.ts)
  meshy/      Meshy client, shared GLB cache (cache.mjs), gen params (genParams.mjs)
  render/     headless Chromium + SwiftShader render harness, multi-angle
              capture, critic cameras, vendored three.js
  server/     Vite dev-middleware API plugin (apiPlugin.ts) + /assets bridge
  scene/      scene + plan schema (schema.ts)
  viewer/     three.js SceneViewer + pinned sample scene
  api/        request/response contract types
  log/        audit logging for Claude + Meshy calls
scripts/      meshy-generate CLI, smoke tests, headless-render host setup
docs/         meshy-api.md, headless-render.md
config/       local.example.json, scene-presets.json
index.html · studio.html · viewer.html   Vite multi-page entries
```

## Scripts

- **`node scripts/meshy-generate.mjs "<prompt>" [--count N] [--mode preview|refine]`**
  — cache-aware best-of-N generator CLI; prints a JSON manifest of candidate GLBs.
  Run with `--help` for the full options, cost, and cache behavior.
- Smoke tests: `scripts/meshy-smoke.mjs`, `scripts/meshy-provider-smoke.mjs`
  (`npm run smoke:provider`), `scripts/pipeline-mock-smoke.mjs`,
  `scripts/render-smoke.mjs`, `scripts/critic-render-smoke.mjs`.
- `scripts/setup-headless-render.sh` — one-shot, no-sudo headless-render host setup.

### npm scripts

| Script | Does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | `tsc --noEmit && vite build` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run smoke:provider` | Meshy asset-provider smoke test |

## Tech stack

Vite + TypeScript + vanilla [three.js](https://threejs.org/) on the front end;
server-side rendering via headless Chromium + software WebGL (SwiftShader) driven
by Playwright; [Meshy.ai](https://www.meshy.ai/) for assets; the local `claude`
CLI (Opus 4.8) for planning and vision critique.

## Further docs

- [`docs/meshy-api.md`](docs/meshy-api.md) — verified Meshy text-to-3D request flow.
- [`docs/headless-render.md`](docs/headless-render.md) — server-side three.js → PNG
  render harness and host setup.
- [`CLAUDE.md`](CLAUDE.md) — agent notes for working in this repo.
