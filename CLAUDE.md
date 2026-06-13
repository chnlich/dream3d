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
