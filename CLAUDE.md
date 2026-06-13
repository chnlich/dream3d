# dream3d — agent notes

Source of truth for the plan: `PLAN.md`. Verified Meshy API reference: `docs/meshy-api.md`.

## Generating 3D objects (Meshy)

Do **not** call the Meshy API directly. Use the internal generator (for ad-hoc
best-of-N) or the pipeline asset provider (in the agent loop). Both share **one**
cache module — `src/meshy/cache.mjs` (single source of truth; types in
`cache.d.ts`) — so they read and write the same `~/.cache/dream3d/meshy/`.

```
node scripts/meshy-generate.mjs "<object prompt>" [--count N] [--mode preview|refine]
                                [--add N] [--rebuild] [--cache-dir <path>]
```

- Returns a JSON manifest on **stdout** (logs go to stderr) listing candidate GLB models — send one prompt, get several candidates to pick from.
- **Cache-aware**: keyed by prompt + mode, so repeat runs are free (no API call, no credits). Cache lives in `~/.cache/dream3d/meshy/`.
- `--add N` generates N **more** candidates and appends them to the cached pool (always generates, ignores existing for the decision, still writes to cache; N falls back to `--count` if omitted). `--rebuild` discards the cached entry for that prompt+mode (deletes its `<key>/` dir and index record), then regenerates `--count` from scratch.
- Each cache dir carries a human-readable `<key>/meta.json` marker — `{ key, prompt, normalizedPrompt, mode }` — so a hash-named dir is identifiable without recomputing sha256. It is written on first touch (a cache hit backfills it; a miss/add/rebuild writes it alongside the generated candidates).
- Run `node scripts/meshy-generate.mjs --help` for the **full** options, requirements, cost, cache behavior, and manifest schema.
- Requires `config/local.json` at the repo root — `{ "meshyApiKey": "msy_..." }` (gitignored) — only when actually generating; a pure cache hit needs no key.

**Pipeline provider**: `src/pipeline/meshyAssetProvider.ts` (`AssetProvider.generate(obj)`) is cache-aware over the same cache. On a hit it returns `{ glbUrl }` where **`glbUrl` is the local `.glb` filesystem path** (the headless renderer accepts a local path) with zero network and zero credits; on a miss it generates one preview candidate, persists it through the shared cache helpers, and returns its local path.

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
