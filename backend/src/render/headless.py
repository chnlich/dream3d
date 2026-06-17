"""Async Playwright headless render harness for dream3d scenes."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import unquote, urlsplit

from playwright.async_api import Browser, Page, async_playwright

Vec3 = tuple[float, float, float]
RenderInput = Mapping[str, Any]
RenderStats = dict[str, Any]

LOGGER = logging.getLogger(__name__)

DEFAULT_WIDTH = 1024
DEFAULT_HEIGHT = 768
DEFAULT_CLEAR_COLOR = 0x1F262E
DEFAULT_TIMEOUT_MS = 30_000

SWIFTSHADER_ARGS = [
    "--no-sandbox",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--disable-dev-shm-usage",
]
WSL_GPU_ARGS = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--headless=new",
    "--ignore-gpu-blocklist",
    "--use-gl=angle",
    "--use-angle=gl",
]
LINUX_GPU_ARGS = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--headless=new",
    "--ignore-gpu-blocklist",
    "--use-gl=angle",
    "--use-angle=vulkan",
]

SOFTWARE_RENDERER_RE = re.compile(r"swiftshader|llvmpipe|swrast|software", re.I)
DATA_URL_PREFIX = "data:image/png;base64,"
WSL_GPU_LIB_DIR = Path("/usr/lib/wsl/lib")
MESA_ADAPTER_ENV = "MESA_D3D12_DEFAULT_ADAPTER_NAME"
MESA_ADAPTER_NVIDIA = "NVIDIA"

REPO_ROOT = Path(__file__).resolve().parents[3]
ASSET_ROOT = REPO_ROOT / "src" / "render"
VENDOR_DIR = ASSET_ROOT / "vendor" / "three"
SCENE_PAGE_PATH = ASSET_ROOT / "scene-page.js"
SCENE_VISUALS_PATH = ASSET_ROOT / "sceneVisuals.js"


@dataclass(frozen=True)
class RenderOptions:
    width: int = DEFAULT_WIDTH
    height: int = DEFAULT_HEIGHT
    clear_color: int = DEFAULT_CLEAR_COLOR
    timeout_ms: int = DEFAULT_TIMEOUT_MS
    browser: Browser | None = None


@dataclass(frozen=True)
class RenderResult:
    png: bytes
    stats: RenderStats
    duration_ms: float


class RenderSession:
    def __init__(
        self,
        *,
        page: Page,
        server: "_ServerHandle",
        browser: Browser,
        owns_browser: bool,
        console_lines: list[str],
    ) -> None:
        self._page = page
        self._server = server
        self._browser = browser
        self._owns_browser = owns_browser
        self._console_lines = console_lines
        self._closed = False

    async def render_view(
        self, camera: Mapping[str, Any] | None = None
    ) -> dict[str, Any]:
        result = await self._page.evaluate(
            "(c) => window.__renderView(c)", _camera_to_json(camera) if camera else None
        )
        data_url = result.get("png") if isinstance(result, dict) else None
        if not isinstance(data_url, str) or not data_url.startswith(DATA_URL_PREFIX):
            raise RuntimeError(
                "Render produced no PNG data URL\n--- console ---\n"
                + "\n".join(self._console_lines)
            )
        return {
            "png": base64.b64decode(data_url[len(DATA_URL_PREFIX) :], validate=True),
            "stats": result["stats"],
        }

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        await self._page.close()
        await self._server.close()
        if self._owns_browser:
            await _close_browser(self._browser)


async def launch_browser() -> Browser:
    playwright = await async_playwright().start()
    try:
        browser = await _launch_browser_with(playwright.chromium)
    except Exception:
        await playwright.stop()
        raise
    _remember_playwright(browser, playwright)
    return browser


async def create_render_session(
    input: RenderInput, *, options: RenderOptions | Mapping[str, Any] | None = None
) -> RenderSession:
    opts = _render_options(options)
    served_input, assets = _register_local_assets(input)
    html = _build_html(served_input, opts)
    server = _start_server(html, assets)

    browser = opts.browser
    owns_browser = browser is None
    if browser is None:
        browser = await launch_browser()

    console_lines: list[str] = []
    page: Page | None = None
    try:
        page = await browser.new_page(
            viewport={"width": opts.width, "height": opts.height},
            device_scale_factor=1,
        )
        page.on(
            "console",
            lambda msg: console_lines.append(f"[{msg.type}] {msg.text}"),
        )
        page.on("pageerror", lambda err: console_lines.append(f"[pageerror] {err}"))

        await page.goto(server.origin, wait_until="load", timeout=opts.timeout_ms)
        await page.wait_for_function(
            "() => window.__renderState === 'done' || window.__renderState === 'error'",
            timeout=opts.timeout_ms,
        )
        state = await page.evaluate("() => window.__renderState")
        if state != "done":
            page_error = await page.evaluate("() => window.__renderError")
            raise RuntimeError(
                f"In-browser scene build failed:\n{page_error}\n--- console ---\n"
                + "\n".join(console_lines)
            )
    except Exception:
        if page is not None:
            await page.close()
        await server.close()
        if owns_browser:
            await _close_browser(browser)
        raise

    return RenderSession(
        page=page,
        server=server,
        browser=browser,
        owns_browser=owns_browser,
        console_lines=console_lines,
    )


async def render_scene_to_png(
    input: RenderInput, *, options: RenderOptions | Mapping[str, Any] | None = None
) -> RenderResult:
    started_at = time.perf_counter()
    session = await create_render_session(input, options=options)
    try:
        rendered = await session.render_view()
        return RenderResult(
            png=rendered["png"],
            stats=rendered["stats"],
            duration_ms=(time.perf_counter() - started_at) * 1000,
        )
    finally:
        await session.close()


async def render_to_png(
    input: RenderInput, *, options: RenderOptions | Mapping[str, Any] | None = None
) -> bytes:
    result = await render_scene_to_png(input, options=options)
    return result.png


def assert_non_blank(stats: RenderStats) -> str | None:
    distinct_colors = stats["distinctColors"]
    if distinct_colors < 8:
        return f"only {distinct_colors} distinct colors"

    non_background_fraction = stats["nonBackgroundFraction"]
    if non_background_fraction < 0.02:
        return (
            f"only {non_background_fraction * 100:.2f}% of pixels differ from "
            "the background"
        )

    luminance_std_dev = stats["luminanceStdDev"]
    if luminance_std_dev < 4:
        return f"luminance std-dev {luminance_std_dev:.2f} is too flat"

    return None


async def _launch_browser_with(chromium: Any) -> Browser:
    if os.environ.get("DREAM3D_HEADLESS_GPU") == "0":
        LOGGER.warning(
            "[headless] DREAM3D_HEADLESS_GPU=0; falling back to SwiftShader "
            "software render"
        )
        return await _launch_swiftshader(chromium)

    env = _gpu_env()
    args = WSL_GPU_ARGS if WSL_GPU_LIB_DIR.exists() else LINUX_GPU_ARGS
    try:
        browser = await chromium.launch(
            channel="chromium", headless=True, args=args, env=env
        )
    except Exception as exc:
        LOGGER.warning(
            "[headless] GPU Chromium unavailable (%s); falling back to "
            "SwiftShader software render",
            exc,
        )
        return await _launch_swiftshader(chromium)

    try:
        renderer = await _probe_webgl_renderer(browser)
    except Exception as exc:
        await browser.close()
        LOGGER.warning(
            "[headless] GPU WebGL renderer probe failed (%s); falling back to "
            "SwiftShader software render",
            exc,
        )
        return await _launch_swiftshader(chromium)

    if SOFTWARE_RENDERER_RE.search(renderer):
        await browser.close()
        LOGGER.warning(
            "[headless] GPU launch reported software WebGL renderer %r; "
            "falling back to SwiftShader software render",
            renderer,
        )
        return await _launch_swiftshader(chromium)

    LOGGER.warning("[headless] WebGL renderer: %s", renderer)
    return browser


async def _launch_swiftshader(chromium: Any) -> Browser:
    return await chromium.launch(
        headless=True, args=SWIFTSHADER_ARGS, env=_env_with_library_dirs(False)
    )


async def _probe_webgl_renderer(browser: Browser) -> str:
    page: Page | None = None
    try:
        page = await browser.new_page()
        renderer = await page.evaluate(
            """() => {
              const gl = document.createElement("canvas").getContext("webgl2");
              if (!gl) return "no WebGL2 context";
              const ext = gl.getExtension("WEBGL_debug_renderer_info");
              return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
            }"""
        )
    finally:
        if page is not None:
            await page.close()
    return str(renderer)


def _gpu_env() -> dict[str, str]:
    env = _env_with_library_dirs(WSL_GPU_LIB_DIR.exists())
    if WSL_GPU_LIB_DIR.exists() and not env.get(MESA_ADAPTER_ENV):
        env[MESA_ADAPTER_ENV] = MESA_ADAPTER_NVIDIA
    return env


def _env_with_library_dirs(include_wsl_gpu: bool) -> dict[str, str]:
    env = os.environ.copy()
    wanted: list[Path] = []
    if include_wsl_gpu:
        wanted.append(WSL_GPU_LIB_DIR)
    wanted.extend(_host_lib_dirs())
    existing = [part for part in env.get("LD_LIBRARY_PATH", "").split(":") if part]

    front = [str(path) for path in wanted if path.exists()]
    for path in reversed(front):
        if path not in existing:
            existing.insert(0, path)
    if existing:
        env["LD_LIBRARY_PATH"] = ":".join(existing)
    return env


def _host_lib_dirs() -> list[Path]:
    suffix = "ubuntu2404" if _ubuntu_codename() == "noble" else "ubuntu2204"
    base = Path.home() / "tools" / "playwright-libs" / suffix
    return [
        base / "usr" / "lib" / "x86_64-linux-gnu",
        base / "lib" / "x86_64-linux-gnu",
    ]


def _ubuntu_codename() -> str:
    try:
        for line in Path("/etc/os-release").read_text().splitlines():
            if line.startswith("VERSION_CODENAME="):
                return line.split("=", 1)[1].strip().strip("\"'")
    except FileNotFoundError:
        return "jammy"
    return "jammy"


class _ServerHandle:
    def __init__(self, server: ThreadingHTTPServer, thread: threading.Thread) -> None:
        self._server = server
        self._thread = thread
        self.origin = f"http://127.0.0.1:{server.server_port}"
        self._closed = False

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        await asyncio.to_thread(self._server.shutdown)
        self._server.server_close()
        await asyncio.to_thread(self._thread.join, 5)


def _start_server(html: str, assets: Mapping[str, Path]) -> _ServerHandle:
    handler = _handler_for(html, assets)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return _ServerHandle(server, thread)


def _handler_for(html: str, assets: Mapping[str, Path]) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            path = unquote(urlsplit(self.path).path)
            try:
                if path == "/":
                    self._send(200, "text/html; charset=utf-8", html.encode())
                    return
                if path == "/scene-page.js":
                    self._send(
                        200,
                        "text/javascript; charset=utf-8",
                        SCENE_PAGE_PATH.read_bytes(),
                    )
                    return
                if path == "/sceneVisuals.js":
                    self._send(
                        200,
                        "text/javascript; charset=utf-8",
                        SCENE_VISUALS_PATH.read_bytes(),
                    )
                    return
                if path.startswith("/vendor/three/"):
                    file_path = (VENDOR_DIR / path.removeprefix("/vendor/three/")).resolve()
                    if not file_path.is_relative_to(VENDOR_DIR.resolve()):
                        self._send(403, "text/plain", b"forbidden")
                        return
                    self._send(200, _mime_for(file_path), file_path.read_bytes())
                    return
                if path.startswith("/assets/"):
                    file_path = assets.get(path)
                    if file_path is None:
                        self._send(404, "text/plain", b"unknown asset")
                        return
                    self._send(200, "model/gltf-binary", file_path.read_bytes())
                    return
                self._send(404, "text/plain", b"not found")
            except Exception as exc:
                self._send(500, "text/plain", f"server error: {exc}".encode())

        def log_message(self, format: str, *args: Any) -> None:
            LOGGER.debug("render server: " + format, *args)

        def _send(self, status: int, content_type: str, body: bytes) -> None:
            self.send_response(status)
            self.send_header("content-type", content_type)
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


def _mime_for(file_path: Path) -> str:
    if file_path.suffix == ".js":
        return "text/javascript; charset=utf-8"
    if file_path.suffix == ".glb":
        return "model/gltf-binary"
    if file_path.suffix == ".json":
        return "application/json"
    return "application/octet-stream"


def _register_local_assets(input: RenderInput) -> tuple[dict[str, Any], dict[str, Path]]:
    input_json = _render_input_to_json(input)
    assets: dict[str, Path] = {}
    objects = []
    for index, obj in enumerate(input_json["objects"]):
        glb_url = obj.get("glbUrl")
        if not glb_url or re.match(r"^https?://", glb_url):
            objects.append(obj)
            continue
        file_path = Path(glb_url).resolve(strict=True)
        serve_path = f"/assets/{index}-{file_path.name}"
        assets[serve_path] = file_path
        objects.append({**obj, "glbUrl": serve_path})
    return {**input_json, "objects": objects}, assets


def _build_html(input: RenderInput, opts: RenderOptions | Mapping[str, Any]) -> str:
    resolved = _render_options(opts)
    importmap = json.dumps(
        {
            "imports": {
                "three": "/vendor/three/three.module.js",
                "three/addons/": "/vendor/three/addons/",
            }
        },
        separators=(",", ":"),
    )
    render_input = json.dumps(
        _render_input_to_json(input), separators=(",", ":"), ensure_ascii=False
    )
    render_opts = json.dumps(
        {
            "width": resolved.width,
            "height": resolved.height,
            "clearColor": resolved.clear_color,
        },
        separators=(",", ":"),
    )
    return f"""<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>html,body{{margin:0;padding:0;background:#000;overflow:hidden}}#c{{display:block;width:{resolved.width}px;height:{resolved.height}px}}</style>
<script type="importmap">{importmap}</script>
</head>
<body>
<canvas id="c" width="{resolved.width}" height="{resolved.height}"></canvas>
<script>
window.__INPUT__ = {render_input};
window.__OPTS__ = {render_opts};
</script>
<script type="module" src="/scene-page.js"></script>
</body>
</html>"""


def _render_input_to_json(input: RenderInput) -> dict[str, Any]:
    raw = _as_mapping(input)
    room = _as_mapping(raw["room"])
    out: dict[str, Any] = {
        "room": {
            "width": room["width"],
            "depth": room["depth"],
            "height": room["height"],
        },
        "objects": [_render_object_to_json(obj) for obj in raw["objects"]],
    }
    if raw.get("camera") is not None:
        out["camera"] = _camera_to_json(raw["camera"])
    return out


def _render_object_to_json(value: Any) -> dict[str, Any]:
    raw = _as_mapping(value)
    obj: dict[str, Any] = {
        "position": raw["position"],
        "rotationYDeg": _value(raw, "rotationYDeg", "rotation_y_deg"),
        "scale": raw["scale"],
    }
    for key, alt in (
        ("glbUrl", "glb_url"),
        ("primitive", "primitive"),
        ("color", "color"),
        ("approxSize", "approx_size"),
    ):
        value = _value(raw, key, alt, missing=None)
        if value is not None:
            obj[key] = value
    return obj


def _camera_to_json(camera: Any) -> dict[str, Any]:
    raw = _as_mapping(camera)
    return {"position": raw["position"], "target": raw["target"]}


def _render_options(options: RenderOptions | Mapping[str, Any] | None) -> RenderOptions:
    if options is None:
        return RenderOptions()
    if isinstance(options, RenderOptions):
        return options
    return RenderOptions(
        width=int(options.get("width", DEFAULT_WIDTH)),
        height=int(options.get("height", DEFAULT_HEIGHT)),
        clear_color=int(
            _value(options, "clear_color", "clearColor", missing=DEFAULT_CLEAR_COLOR)
        ),
        timeout_ms=int(
            _value(options, "timeout_ms", "timeoutMs", missing=DEFAULT_TIMEOUT_MS)
        ),
        browser=options.get("browser"),
    )


def _as_mapping(value: Any) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return value
    if hasattr(value, "model_dump"):
        return value.model_dump(by_alias=True)
    if hasattr(value, "__dict__"):
        return value.__dict__
    raise TypeError(f"expected mapping-like value, got {type(value).__name__}")


def _value(
    raw: Mapping[str, Any], key: str, alt: str, *, missing: Any = ...
) -> Any:
    if key in raw:
        return raw[key]
    if alt in raw:
        return raw[alt]
    if missing is ...:
        raise KeyError(key)
    return missing


_PLAYWRIGHT_BY_BROWSER: dict[int, Any] = {}


def _remember_playwright(browser: Browser, playwright: Any) -> None:
    _PLAYWRIGHT_BY_BROWSER[id(browser)] = playwright
    original_close = browser.close

    async def close_with_playwright(*args: Any, **kwargs: Any) -> Any:
        tracked = _PLAYWRIGHT_BY_BROWSER.pop(id(browser), None)
        try:
            return await original_close(*args, **kwargs)
        finally:
            if tracked is not None:
                await tracked.stop()

    try:
        setattr(browser, "close", close_with_playwright)
    except (AttributeError, TypeError):
        pass


async def _close_browser(browser: Browser) -> None:
    try:
        await browser.close()
    finally:
        playwright = _PLAYWRIGHT_BY_BROWSER.pop(id(browser), None)
        if playwright is not None:
            await playwright.stop()
