# dream3d — agent notes

Source of truth for the plan: `PLAN.md`. Verified Meshy API reference: `docs/meshy-api.md`.

## Generating 3D objects (Meshy)

Do **not** call the Meshy API directly. Use the internal generator (for ad-hoc
best-of-N) or the pipeline asset provider (in the agent loop). Both share **one**
cache module — `src/meshy/cache.mjs` (single source of truth; types in
`cache.d.ts`) — so they read and write the same `~/.cache/dream3d/meshy/`. The
fixed preview/refine submit params live in **one** typed module —
`src/meshy/genParams.mjs` (types in `genParams.d.ts`) — read by both the CLI and
the provider, and the cache key folds in a signature of them (see below), so the
two paths submit identical jobs and never serve assets generated under stale params.

```
node scripts/meshy-generate.mjs "<object prompt>" [--count N] [--mode preview|refine]
                                [--add N] [--rebuild] [--cache-dir <path>]
```

- Returns a JSON manifest on **stdout** (logs go to stderr) listing candidate GLB models — send one prompt, get several candidates to pick from.
- **Cache-aware**: keyed by prompt + mode + a signature of the generation params (`src/meshy/genParams.mjs`), so repeat runs are free (no API call, no credits) and changing any param yields a new key. Cache lives in `~/.cache/dream3d/meshy/`. (The refine key's signature also includes the preview params, since a refined asset is built on the preview mesh.) This param-aware key **invalidated the prior seeded cache** — old `prompt::mode`-only entries are unreachable and re-generate under the new key; intended and acceptable.
- `--add N` generates N **more** candidates and appends them to the cached pool (always generates, ignores existing for the decision, still writes to cache; N falls back to `--count` if omitted). `--rebuild` discards the cached entry for that prompt+mode (deletes its `<key>/` dir and index record), then regenerates `--count` from scratch.
- Each cache dir carries a human-readable `<key>/meta.json` marker — `{ key, prompt, normalizedPrompt, mode }` — so a hash-named dir is identifiable without recomputing sha256. It is written on first touch (a cache hit backfills it; a miss/add/rebuild writes it alongside the generated candidates).
- Run `node scripts/meshy-generate.mjs --help` for the **full** options, requirements, cost, cache behavior, and manifest schema.
- Requires `config/local.json` at the repo root — `{ "meshyApiKey": "msy_..." }` (gitignored) — only when actually generating; a pure cache hit needs no key.

**Pipeline provider**: `src/pipeline/meshyAssetProvider.ts` (`AssetProvider.generate(obj)`) is cache-aware over the same cache and runs **preview → refine**, returning the **TEXTURED refined GLB** (never the gray preview). On a hit it returns `{ glbUrl }` where **`glbUrl` is the local `.glb` filesystem path** of the refined model (the headless renderer accepts a local path) with zero network and zero credits; on a miss it submits a preview (poly-bounded mesh), then a refine (bakes PBR texture), persists the refined GLB through the shared cache helpers, and returns its local path. Verified live (2026-06-13) on "a small ceramic mug": refined GLB carried embedded PBR color and **293,083 triangles** (≤ the 300,000 target).

## Multi-angle scene capture

Render one PNG per camera **in-process** — this is what the agent loop calls:

```ts
import { launchBrowser } from "./render/headless";  // paths relative to src/
import { captureViews } from "./render/multiangle";
const browser = await launchBrowser();              // launch ONCE per loop; reuse across passes; close at end
const shots = await captureViews(scene, cameras, { browser });  // ViewShot[] { name, png, stats, camera }
// cameras: CameraSpec[] = { name, position, target? | direction? }   // exactly one of target/direction
// shots[i].png (Buffer) -> base64 -> Opus vision critic
```

- **Reuse the warm browser** — launch once, pass `{ browser }` to every pass: the cold start is paid once, then each view is fast.
- CLI tester (no `--scene`/`--cameras` ⇒ bundled SC demo fixtures): `node src/render/multiangle/capture-views.mjs [--scene f.json] [--cameras c.json] [--out dir] [--width px] [--height px]` — run `--help` for full options.
- Authoritative signature + types live in `src/render/multiangle/index.ts` and `types.ts` (`captureViews`, `CameraSpec`, `ViewShot`, `CaptureOptions`) — not duplicated here.
