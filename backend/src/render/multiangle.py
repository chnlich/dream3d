"""Multi-angle scene capture over one persistent headless render session."""

from __future__ import annotations

import json
import logging
import os
import re
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from render.headless import (
    RenderOptions,
    RenderStats,
    Vec3,
    assert_non_blank as headless_assert_non_blank,
    create_render_session,
)

LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class CaptureOptions:
    width: int = 1024
    height: int = 768
    clear_color: int = 0x1F262E
    timeout_ms: int = 30_000
    out_dir: str | Path | None = None
    browser: Any | None = None
    assert_non_blank: bool = True
    job_id: str | None = None


@dataclass(frozen=True)
class ViewShot:
    name: str
    png: bytes
    stats: RenderStats
    duration_ms: float
    camera: dict[str, Vec3]
    blank_warning: str | None = None


async def capture_views(
    scene: Mapping[str, Any],
    cameras: list[Any],
    *,
    options: CaptureOptions | Mapping[str, Any] | None = None,
) -> list[ViewShot]:
    opts = _capture_options(options)
    resolved = _resolve_cameras(cameras)
    session = await create_render_session(
        scene,
        options=RenderOptions(
            width=opts.width,
            height=opts.height,
            clear_color=opts.clear_color,
            timeout_ms=opts.timeout_ms,
            browser=opts.browser,
        ),
    )

    shots: list[ViewShot] = []
    try:
        for camera in resolved:
            started_at = time.perf_counter()
            rendered = await session.render_view(camera["camera"])
            duration_ms = (time.perf_counter() - started_at) * 1000
            blank_warning = None
            if opts.assert_non_blank:
                warning = headless_assert_non_blank(rendered["stats"])
                if warning is not None:
                    LOGGER.warning(
                        '[blank warning] view "%s": %s', camera["name"], warning
                    )
                    _dump_blank_png(camera["name"], rendered["png"], opts.job_id)
                    if os.environ.get("DREAM3D_RENDER_STRICT_BLANK") == "1":
                        raise RuntimeError(f"Render looks blank: {warning}")
                    blank_warning = warning
            shots.append(
                ViewShot(
                    name=camera["name"],
                    png=rendered["png"],
                    stats=rendered["stats"],
                    duration_ms=duration_ms,
                    camera=camera["camera"],
                    blank_warning=blank_warning,
                )
            )
    finally:
        await session.close()

    if opts.out_dir is not None:
        _write_outputs(Path(opts.out_dir), shots)
    return shots


def _resolve_cameras(cameras: list[Any]) -> list[dict[str, Any]]:
    if len(cameras) < 1:
        raise ValueError("capture_views: at least one camera is required")
    seen: set[str] = set()
    resolved: list[dict[str, Any]] = []
    for camera in cameras:
        cam = _as_mapping(camera)
        name = str(cam["name"])
        if name in seen:
            raise ValueError(f'capture_views: duplicate camera name "{name}"')
        seen.add(name)

        has_target = cam.get("target") is not None
        has_direction = cam.get("direction") is not None
        if has_target == has_direction:
            raise ValueError(f'camera "{name}": exactly one of target/direction is required')

        position = _vec3(cam["position"])
        if has_target:
            target = _vec3(cam["target"])
        else:
            direction = _vec3(cam["direction"])
            target = (
                position[0] + direction[0],
                position[1] + direction[1],
                position[2] + direction[2],
            )
        resolved.append(
            {
                "name": name,
                "camera": {"position": position, "target": target},
            }
        )
    return resolved


def _dump_blank_png(view_name: str, png: bytes, job_id: str | None) -> None:
    try:
        debug_dir = Path.home() / ".cache" / "dream3d" / "debug"
        safe_view = re.sub(r"[^a-zA-Z0-9_-]", "_", view_name)
        identifier = job_id or uuid.uuid4().hex[:8]
        timestamp = (
            datetime.now(timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
            .replace(":", "-")
            .replace(".", "-")
        )
        debug_dir.mkdir(parents=True, exist_ok=True)
        (debug_dir / f"blank-{safe_view}-{identifier}-{timestamp}.png").write_bytes(
            png
        )
    except Exception:
        LOGGER.warning("failed to dump blank render PNG", exc_info=True)


def _write_outputs(out_dir: Path, shots: list[ViewShot]) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    views = []
    for shot in shots:
        file = f"{shot.name}.png"
        (out_dir / file).write_bytes(shot.png)
        views.append(
            {
                "name": shot.name,
                "file": file,
                "camera": shot.camera,
                "stats": shot.stats,
            }
        )
    manifest = {
        "width": shots[0].stats["width"],
        "height": shots[0].stats["height"],
        "views": views,
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )


def _capture_options(options: CaptureOptions | Mapping[str, Any] | None) -> CaptureOptions:
    if options is None:
        return CaptureOptions()
    if isinstance(options, CaptureOptions):
        return options
    return CaptureOptions(
        width=int(options.get("width", 1024)),
        height=int(options.get("height", 768)),
        clear_color=int(_value(options, "clear_color", "clearColor", 0x1F262E)),
        timeout_ms=int(_value(options, "timeout_ms", "timeoutMs", 30_000)),
        out_dir=_value(options, "out_dir", "outDir", None),
        browser=options.get("browser"),
        assert_non_blank=bool(
            _value(options, "assert_non_blank", "assertNonBlank", True)
        ),
        job_id=_value(options, "job_id", "jobId", None),
    )


def _as_mapping(value: Any) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return value
    if hasattr(value, "__dict__"):
        return value.__dict__
    raise TypeError(f"expected mapping-like camera, got {type(value).__name__}")


def _vec3(value: Any) -> Vec3:
    x, y, z = value
    return (float(x), float(y), float(z))


def _value(raw: Mapping[str, Any], key: str, alt: str, default: Any) -> Any:
    if key in raw:
        return raw[key]
    if alt in raw:
        return raw[alt]
    return default
