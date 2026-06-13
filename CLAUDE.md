# dream3d — agent notes

Source of truth for the plan: `PLAN.md`. Verified Meshy API reference: `docs/meshy-api.md`.

## Generating 3D objects (Meshy)

Do **not** call the Meshy API directly — use the internal generator:

```
node scripts/meshy-generate.mjs "<object prompt>" [--count N] [--mode preview|refine]
```

- Returns a JSON manifest on **stdout** (logs go to stderr) listing candidate GLB models — send one prompt, get several candidates to pick from.
- **Cache-aware**: keyed by prompt + mode, so repeat runs are free (no API call, no credits). Cache lives in `~/.cache/dream3d/meshy/`.
- Run `node scripts/meshy-generate.mjs --help` for the **full** options, requirements, cost, cache behavior, and manifest schema.
- Requires `config/local.json` at the repo root — `{ "meshyApiKey": "msy_..." }` (gitignored) — only when actually generating; a pure cache hit needs no key.

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
