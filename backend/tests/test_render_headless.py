"""Tests for the Python headless render port."""

from __future__ import annotations

import json
import re

import pytest

from render.critic_cameras import critic_cameras
from render.headless import (
    RenderOptions,
    _build_html,
    _register_local_assets,
    assert_non_blank,
)
from render.multiangle import capture_views


def test_critic_cameras_match_room_formula() -> None:
    cameras = critic_cameras({"width": 5, "depth": 4, "height": 3})

    assert [camera.name for camera in cameras] == ["front", "left34", "right34"]
    assert len(cameras) == 3
    assert cameras[0].target == pytest.approx((0, 0.9, 0))
    assert cameras[0].position == pytest.approx((0, 4.3, 5.9405), abs=1e-4)

    left = cameras[1].position
    right = cameras[2].position
    assert left[0] == pytest.approx(-right[0])
    assert left[1] == pytest.approx(right[1])
    assert left[2] == pytest.approx(right[2])


def test_assert_non_blank_accepts_healthy_stats() -> None:
    assert (
        assert_non_blank(
            {
                "distinctColors": 20,
                "nonBackgroundFraction": 0.25,
                "luminanceStdDev": 12.5,
            }
        )
        is None
    )


@pytest.mark.parametrize(
    ("stats", "message"),
    [
        (
            {"distinctColors": 7, "nonBackgroundFraction": 0.5, "luminanceStdDev": 8},
            "only 7 distinct colors",
        ),
        (
            {"distinctColors": 8, "nonBackgroundFraction": 0.0199, "luminanceStdDev": 8},
            "only 1.99% of pixels differ from the background",
        ),
        (
            {"distinctColors": 8, "nonBackgroundFraction": 0.02, "luminanceStdDev": 3.999},
            "luminance std-dev 4.00 is too flat",
        ),
    ],
)
def test_assert_non_blank_reports_each_threshold(
    stats: dict[str, float], message: str
) -> None:
    assert assert_non_blank(stats) == message


def test_render_input_serializes_camel_case_and_rewrites_local_glbs(
    tmp_path,
) -> None:
    local_glb = tmp_path / "chair.glb"
    local_glb.write_bytes(b"glb")
    scene = {
        "room": {"width": 5, "depth": 4, "height": 3},
        "objects": [
            {
                "glbUrl": str(local_glb),
                "position": [0, 0.5, 0],
                "rotationYDeg": 15,
                "scale": 1,
                "approxSize": [1, 1, 1],
            },
            {
                "glbUrl": "https://example.test/sofa.glb",
                "position": [1, 0.5, 0],
                "rotationYDeg": 0,
                "scale": 1,
            },
        ],
        "camera": {"position": [0, 4, 5], "target": [0, 1, 0]},
    }

    served, assets = _register_local_assets(scene)
    html = _build_html(served, RenderOptions(width=320, height=240))
    match = re.search(r"window\.__INPUT__ = (.*);", html)

    assert match is not None
    serialized = json.loads(match.group(1))
    assert serialized["room"] == {"width": 5, "depth": 4, "height": 3}
    assert serialized["objects"][0]["glbUrl"] == "/assets/0-chair.glb"
    assert serialized["objects"][0]["rotationYDeg"] == 15
    assert serialized["objects"][0]["approxSize"] == [1, 1, 1]
    assert serialized["objects"][1]["glbUrl"] == "https://example.test/sofa.glb"
    assert serialized["camera"] == {"position": [0, 4, 5], "target": [0, 1, 0]}
    assert assets["/assets/0-chair.glb"] == local_glb.resolve()


@pytest.mark.asyncio
async def test_capture_views_rejects_empty_cameras() -> None:
    with pytest.raises(ValueError, match="at least one camera"):
        await capture_views(_primitive_scene(), [], options={"assert_non_blank": False})


@pytest.mark.asyncio
async def test_capture_views_rejects_duplicate_names() -> None:
    cameras = [
        {"name": "front", "position": [0, 1, 2], "target": [0, 0, 0]},
        {"name": "front", "position": [0, 1, 2], "target": [0, 0, 0]},
    ]
    with pytest.raises(ValueError, match='duplicate camera name "front"'):
        await capture_views(_primitive_scene(), cameras, options={"assert_non_blank": False})


@pytest.mark.asyncio
async def test_capture_views_rejects_both_target_and_direction() -> None:
    cameras = [
        {
            "name": "bad",
            "position": [0, 1, 2],
            "target": [0, 0, 0],
            "direction": [0, -1, 0],
        }
    ]
    with pytest.raises(ValueError, match="exactly one of target/direction"):
        await capture_views(_primitive_scene(), cameras, options={"assert_non_blank": False})


@pytest.mark.asyncio
async def test_capture_views_rejects_neither_target_nor_direction() -> None:
    cameras = [{"name": "bad", "position": [0, 1, 2]}]
    with pytest.raises(ValueError, match="exactly one of target/direction"):
        await capture_views(_primitive_scene(), cameras, options={"assert_non_blank": False})


@pytest.mark.asyncio
async def test_capture_views_resolves_direction_to_target(monkeypatch) -> None:
    class FakeSession:
        async def render_view(self, camera):
            self.camera = camera
            return {
                "png": b"\x89PNG\r\n\x1a\nfake",
                "stats": {
                    "width": 16,
                    "height": 16,
                    "distinctColors": 12,
                    "nonBackgroundFraction": 0.25,
                    "luminanceStdDev": 8,
                },
            }

        async def close(self):
            self.closed = True

    fake_session = FakeSession()

    async def fake_create_render_session(scene, *, options):
        return fake_session

    monkeypatch.setattr(
        "render.multiangle.create_render_session", fake_create_render_session
    )

    shots = await capture_views(
        _primitive_scene(),
        [{"name": "ray", "position": [1, 2, 3], "direction": [4, -1, 0.5]}],
        options={"assert_non_blank": False},
    )

    assert shots[0].camera == {"position": (1, 2, 3), "target": (5, 1, 3.5)}
    assert fake_session.camera == shots[0].camera
    assert fake_session.closed is True


@pytest.mark.asyncio
async def test_capture_views_browser_smoke_renders_non_blank_png() -> None:
    scene = _primitive_scene()
    cameras = critic_cameras(scene["room"])
    try:
        shots = await capture_views(
            scene,
            cameras,
            options={"width": 320, "height": 240, "timeout_ms": 30_000},
        )
    except Exception as exc:
        if _chromium_unavailable(str(exc)):
            pytest.skip(f"Chromium unavailable for headless render smoke: {exc}")
        raise

    assert len(shots) == 3
    for shot in shots:
        assert shot.png.startswith(b"\x89PNG\r\n\x1a\n")
        assert len(shot.png) > 100
        assert assert_non_blank(shot.stats) is None


def _primitive_scene() -> dict:
    return {
        "room": {"width": 5, "depth": 4, "height": 3},
        "objects": [
            {
                "primitive": "box",
                "position": [0, 0.5, 0],
                "rotationYDeg": 0,
                "scale": 1,
                "color": 0xFF6B6B,
            }
        ],
    }


def _chromium_unavailable(message: str) -> bool:
    markers = (
        "Executable doesn't exist",
        "playwright install",
        "Host system is missing dependencies",
    )
    return any(marker in message for marker in markers) or (
        "BrowserType.launch" in message
        and "Target page, context or browser has been closed" in message
    )
