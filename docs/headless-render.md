# Headless render — server-side three.js → PNG

This documents the de-risking spike for dream3d's **#1 risk**: rendering a three.js
scene to a PNG **server-side**, so the agent loop can screenshot a scene and feed it
to the Opus vision critic (the scene-review step of the agent loop).

**Result: proven.** Headless Chromium gets a real **WebGL 2.0** context and renders a
lit, multi-object scene to a non-blank PNG. By **default** it now drives the **real
GPU** — ANGLE → D3D12 on the discrete **NVIDIA RTX 3060** — and falls back **loudly**
to **SwiftShader** (software GL) when full Chromium is unavailable. `node
scripts/render-smoke.mjs` produces `scripts/.out/render-smoke.png` (1024×768, ~70 KiB).

```
┌───────────────┐   RenderInput    ┌──────────────────┐  http://127.0.0.1  ┌───────────────────┐
│ agent loop /  │ ───────────────▶ │ renderToPng()    │ ─────────────────▶ │ headless Chromium │
│ render-smoke  │                  │ (src/render/     │   page + three.js  │ + GPU / SW WebGL  │
│               │ ◀─────────────── │  headless.ts)    │ ◀───────────────── │ canvas.toDataURL  │
└───────────────┘   PNG Buffer     └──────────────────┘   data:image/png   └───────────────────┘
```

## Environment proven on

| | |
|---|---|
| Host | Ubuntu 22.04.5 LTS (jammy) x86_64 WSL2 **or** Ubuntu 24.04.4 LTS (noble) x86_64 headless; NVIDIA GPU on WSL2, software-only fallback on the SLURM login host |
| Node | v22.22.3 (strips TypeScript types natively → a `.mjs` can `import` the `.ts` harness) |
| Playwright | 1.60.0 → Chromium **1223**: full `chromium` (GPU path) + `chromium_headless_shell` (software fallback) |
| three.js | 0.170.0 (vendored in `src/render/vendor/three`) |
| WebGL | `WebGL 2.0 (OpenGL ES 3.0 Chromium)` — default **ANGLE → D3D12 (NVIDIA RTX 3060)**; fallback ANGLE + SwiftShader (software) |

---

## Setup from scratch

One command does everything (no `sudo`, installs only under `~/tools` and
`$XDG_CACHE_HOME/ms-playwright` / `~/.cache/ms-playwright`, idempotent):

```bash
bash scripts/setup-headless-render.sh
node scripts/render-smoke.mjs        # -> scripts/.out/render-smoke.png
```

The script detects the OS codename (jammy/noble) and maps package names
accordingly, so it works on Ubuntu 22.04 and 24.04.

The script performs the three steps below. Run them by hand if you prefer.

### 1. Importable Playwright package (no `package.json` change)

The repo's `package.json` is owned by the foundation worker (it declares
`@playwright/test`). To keep this spike independent we install a host-level copy:

```bash
mkdir -p ~/tools/playwright && cd ~/tools/playwright
npm init -y && npm install playwright@1.60.0
```

`src/render/headless.ts` resolves Playwright by trying the bare specifier
`playwright` first (works once the project's `node_modules` exists), then falling
back to `~/tools/playwright/node_modules/playwright`.

### 2. Chromium browser binary

```bash
export PLAYWRIGHT_BROWSERS_PATH="${XDG_CACHE_HOME:-$HOME/.cache}/ms-playwright"
~/tools/playwright/node_modules/.bin/playwright install chromium
# installs BOTH builds into $PLAYWRIGHT_BROWSERS_PATH:
#   chromium-<rev>                FULL Chromium — required by the GPU path (channel:"chromium")
#   chromium_headless_shell-<rev> the software-fallback / legacy-headless build
```

> **The GPU path needs the full Chromium.** `launchBrowser()` launches with
> `channel:"chromium"`, which resolves to `chromium-<rev>`. The default headless
> shell *always* falls back to SwiftShader, so without the full build you only get
> the software path (the loud fallback covers its absence, but GPU won't engage).

> `playwright install --with-deps chromium` would also install the system
> libraries, **but `--with-deps` runs `apt-get` via `sudo`** and this host has no
> passwordless sudo — hence step 3.

### 3. Chromium's system libraries — *without root*

We re-establish the user-writable library prefix by downloading the `.deb`s and
extracting them (no `sudo`; `apt-get download` and `dpkg-deb -x` do not need
root). The directory name includes the OS codename so the harness picks the right
one (`ubuntu2204` for jammy, `ubuntu2404` for noble):

```bash
CODENAME=$(lsb_release -cs)
SUFFIX=$([ "$CODENAME" = "noble" ] && echo "ubuntu2404" || echo "ubuntu2204")
mkdir -p ~/tools/playwright-libs/$SUFFIX && cd /tmp

# On Ubuntu 24.04 (noble) several libraries gained the t64 suffix.
if [ "$CODENAME" = "noble" ]; then
  PKGS=(libnspr4 libnss3 libasound2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 libcups2t64 libdbus-1-3 libdrm2 libgbm1 libexpat1 libglib2.0-0t64 libpango-1.0-0 libcairo2 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 libxshmfence1)
else
  PKGS=(libnspr4 libnss3 libasound2 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 libexpat1 libglib2.0-0 libpango-1.0-0 libcairo2 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 libxshmfence1)
fi

apt-get download "${PKGS[@]}"
for d in *.deb; do dpkg-deb -x "$d" ~/tools/playwright-libs/$SUFFIX; done
```

(`libnssutil3` / `libsmime3` are bundled inside `libnss3`, so they are not listed.)

`headless.ts` prepends these dirs to `LD_LIBRARY_PATH` **in-process before launching
Chromium**, so the spawned browser inherits them — `node scripts/render-smoke.mjs`
works with no env prefix. Equivalent manual run (use `ubuntu2404` instead of `ubuntu2204` on Ubuntu 24.04):

```bash
LD_LIBRARY_PATH=~/tools/playwright-libs/ubuntu2204/usr/lib/x86_64-linux-gnu:\
~/tools/playwright-libs/ubuntu2204/lib/x86_64-linux-gnu \
  node scripts/render-smoke.mjs
```

### Chromium launch flags + GPU/software selection

`launchBrowser()` in `headless.ts` chooses the backend at launch:

**Default — real GPU (ANGLE → D3D12 on the NVIDIA RTX 3060).** It launches the
**full** Chromium (`channel:"chromium"`, new headless) with `GPU_LAUNCH_ARGS`:

```
--no-sandbox                 # required under WSL
--disable-dev-shm-usage      # avoid small /dev/shm in containers/WSL
--headless=new               # the new headless mode (the GPU-capable one)
--ignore-gpu-blocklist       # WSL's GPU is blocklisted by default; override it
--use-gl=angle               # GL via ANGLE
--use-angle=gl               # ANGLE backend = desktop GL over the WSL D3D12 stack
```

Two pieces of env are set **in-process before launch** (the spawned browser child
inherits them; Node itself does not need them):

- **`LD_LIBRARY_PATH`** — `/usr/lib/wsl/lib` is **prepended first** (WSL's GPU
  userspace: `libd3d12`, `libdxcore`, the Mesa d3d12 Gallium driver) ahead of the
  extracted playwright-libs dirs, so ANGLE's D3D12 backend can find the GPU stack.
- **`MESA_D3D12_DEFAULT_ADAPTER_NAME=NVIDIA`** — steers Mesa's d3d12 driver to the
  discrete RTX 3060. Omit it and Mesa picks the AMD iGPU (also GPU, slightly slower).
  An existing value is respected (not overwritten).

This combination is the **only** one that engages the real GPU on this box — Vulkan,
EGL, and desktop GL (`--use-gl=desktop`) all silently fell back to SwiftShader (see
the GPU probe). When it works, `UNMASKED_RENDERER_WEBGL` reads
`ANGLE (Microsoft Corporation, D3D12 (NVIDIA GeForce RTX 3060 Laptop GPU), OpenGL 4.2)`.
`launchBrowser()` logs this string after every launch (a `[headless] WebGL renderer: …`
line) so logs always show which backend engaged.

**Loud fallback — software (SwiftShader).** If the GPU launch throws (e.g. full
Chromium isn't installed → Playwright can't resolve `channel:"chromium"`),
`launchBrowser()` emits a loud `console.warn` (`[headless] GPU Chromium unavailable
(…); falling back to SwiftShader software render`) and launches the software path with
`CHROMIUM_LAUNCH_ARGS` (kept under its original export name for back-compat):

```
--no-sandbox                 # required under WSL
--use-gl=angle               # GL via ANGLE
--use-angle=swiftshader      # ANGLE backend = SwiftShader (software, no GPU needed)
--enable-unsafe-swiftshader  # recent Chromium gates SwiftShader WebGL behind this
--disable-dev-shm-usage      # avoid small /dev/shm in containers/WSL
```

Only if the software launch *also* fails does `launchBrowser()` throw.

**Escape hatch — `DREAM3D_HEADLESS_GPU=0`.** Set this to skip the GPU attempt entirely
and go straight to the software path (portability / debugging). Unset (the default)
attempts GPU first.

---

## What the harness is

| File | Role |
|---|---|
| `src/render/headless.ts` | Reusable API: `renderToPng(input)`, `renderSceneToPng(input)`, `launchBrowser()` (GPU-first, loud software fallback), `assertNonBlank(stats)`, `CHROMIUM_LAUNCH_ARGS` (software flags) + `GPU_LAUNCH_ARGS`, and the `RenderInput` type. Runs a zero-dependency local HTTP server (page + vendored three + GLB assets), drives Chromium, captures via `canvas.toDataURL`. |
| `src/render/scene-page.js` | Browser-side module. Builds the scene (room + primitives/GLB), renders one frame, exposes the PNG + pixel stats on `window`. Uses `WebGLRenderer({ preserveDrawingBuffer: true })` + `toDataURL` — the same capture path the real viewer uses. |
| `src/render/vendor/three/` | three.js 0.170.0 build + `GLTFLoader` + `BufferGeometryUtils`, vendored so the spike runs with **no `npm install` and no network at render time**. |
| `scripts/render-smoke.mjs` | Self-contained proof: renders a hardcoded scene, writes the PNG, verifies it is non-blank, prints stats. |
| `scripts/setup-headless-render.sh` | The setup above, executable + idempotent. |

### Reusable API

```ts
import { renderToPng, renderSceneToPng, launchBrowser, type RenderInput } from "../src/render/headless.ts";

const input: RenderInput = {
  room: { width: 4, depth: 4, height: 2.6 },
  objects: [
    { primitive: "box",      position: [0, 0.5, 0],     rotationYDeg: 20, scale: 1.0, color: 0xff6b6b },
    { primitive: "cylinder", position: [1.3, 0.6, -0.6], rotationYDeg: 0,  scale: 1.2 },
    { glbUrl: "/abs/path/to/asset.glb", position: [-1, 0, 0], rotationYDeg: 90, scale: 1 },
  ],
  // camera optional; omit for an auto 3/4 framing of the whole room
};

const png: Buffer = await renderToPng(input);          // simplest
const { png, stats, durationMs } = await renderSceneToPng(input); // + verification data
```

`glbUrl` may be an `http(s)://` URL (fetched directly by the page) **or** a local
filesystem path (served automatically over the harness's local HTTP server).

**Non-blank verification.** `scene-page.js` reads the rendered pixels back and
reports `{ distinctColors, nonBackgroundFraction, meanLuminance, luminanceStdDev }`.
`assertNonBlank(stats)` returns a warning string if the frame looks degenerate, otherwise `null`; callers decide whether to warn, throw, or ignore. The smoke test turns a returned warning back into a hard error; `src/render/multiangle/index.ts` warns, dumps a debug PNG, and only throws when `DREAM3D_RENDER_STRICT_BLANK=1`. The smoke also re-checks
the PNG header (valid signature + expected dimensions) and file size. For the smoke
scene: `distinctColors=135`, `nonBackgroundFraction=53.2%`, `luminanceStdDev=48.1`.

---

## Integration notes (feeding a real `SceneState`)

### `SceneState` → `RenderInput`

This spike deliberately does **not** import the project scene schema. At
integration, map the post-layout scene to `RenderInput`:

| `SceneState` (post-layout) | `RenderInput` |
|---|---|
| `room { w, d, h }` | `room { width, depth, height }` |
| object's resolved transform | `position: [x, y, z]`, `rotationYDeg`, `scale` |
| object's downloaded Meshy GLB (local cache path or URL) | `glbUrl` |
| objects still generating / fallback | `primitive: "box" \| "cylinder"` placeholder |
| (optional) stored view | `camera { position, target }` — else auto-framed |

Sketch:

```ts
const input: RenderInput = {
  room: { width: scene.room.w, depth: scene.room.d, height: scene.room.h },
  objects: scene.objects.map((o) => ({
    glbUrl: o.glbPath,                              // local cache path is fine
    position: [o.transform.x, o.transform.y, o.transform.z],
    rotationYDeg: o.transform.rotationYDeg,
    scale: o.transform.scale,
  })),
};
const png = await renderToPng(input);               // -> base64 -> Opus vision critic
```

Note the harness already captures via `toDataURL`, exactly the data URL the critic
expects — no separate client round-trip is required for the server-side path.

### Latency (measured on this host, 1024×768)

The table below is the **software** (SwiftShader) path. On the **GPU** path the render
itself is ~**141× faster** (median render-only **3.2 ms** vs **452 ms** on a
912k-triangle, 5-camera SC scene — see the GPU probe). Full-Chromium cold launch is
heavier than the headless shell, so the GPU win is render-only throughput on
non-trivial scenes, not one-shot cold renders of a few primitives.

| Scenario | Time |
|---|---|
| **Cold** — `renderToPng` with no reused browser (launch + first GL context + first frame) | **~0.9–1.0 s** |
| Playwright `launch()` call alone | ~45 ms (so cold cost is dominated by **first GL init + first frame**, not launch) |
| **Warm** — `renderSceneToPng` reusing one browser | **~260–280 ms / render** (median 276 ms) |
| 4 renders **concurrently** on one shared browser | ~750 ms total (~190 ms amortized), individual calls ~720–750 ms under contention |

### Recommendations / caveats

- **Keep one browser warm.** The agent loop does up to 5 vision passes per scene.
  Launch once and reuse, paying cold-start only once:
  ```ts
  const browser = await launchBrowser();
  try {
    for (const pass of passes) {
      const png = await renderToPng(buildInput(pass), { browser });
    }
  } finally {
    await browser.close();
  }
  ```
  This turns each pass from ~1 s into ~0.3 s.
- **Concurrency.** One browser handles concurrent renders (each call opens its own
  page + ephemeral local server). Under SwiftShader the renders share CPU, so
  concurrency improves throughput but not per-call latency; for the 5-pass loop
  (sequential anyway) one warm browser is plenty. A small pool (2–3 browsers) is the
  next lever if many scenes render in parallel.
- **Backend quality.** The default GPU path (ANGLE → D3D12) is hardware-accelerated,
  so heavy scenes are cheap. The SwiftShader fallback is correct but unaccelerated;
  antialiasing, lighting, and GLB materials all render fine (see `render-smoke.png`),
  but heavy scenes cost CPU/time — under the software path keep the object cap (4–6).
- **Determinism.** No animation loop — exactly one frame (rendered twice across a RAF
  so GLB textures are present), so screenshots are stable for the critic.

### Cleanup at integration time

- Once the foundation worker's `three` dependency lands, the page can be served
  `node_modules/three/build/three.module.js` instead of the vendored copy, and
  `src/render/vendor/three/` can be deleted. (Resolution prefers bare `playwright`
  already; do the same for three by pointing the importmap at `node_modules`.)
- On a host **with** root (e.g. CI), replace step 3 with
  `playwright install --with-deps chromium` and drop the `LD_LIBRARY_PATH` handling —
  `ensureLibraryPath()` is a no-op when those dirs are absent.
