"""Tests for /api/generate wiring."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

import api.generate as api_generate
from scene.schema import (
    GenerateResponse,
    Pass,
    Room,
    SceneObject,
    SceneState,
    Transform,
)
from server.job_store import JobStore


def _response() -> GenerateResponse:
    obj = SceneObject(
        id="chair",
        label="chair",
        meshy_prompt="chair",
        approx_size=(1.0, 1.0, 1.0),
        transform=Transform(position=(0.0, 0.5, 0.0), rotation_y_deg=0.0, scale=1.0),
        glb_url="/assets/chair.glb",
        status="ready",
    )
    return GenerateResponse(
        passes=[
            Pass(
                scene_state=SceneState(
                    room=Room(width=4.0, depth=4.0, height=3.0),
                    objects=[obj],
                    pass_=0,
                )
            )
        ]
    )


def test_format_event_exact_strings() -> None:
    cases: list[tuple[dict[str, Any], str]] = [
        ({"kind": "plan"}, "Planning scene…"),
        ({"kind": "plan_done", "object_count": 3}, "Plan ready — 3 object(s)"),
        (
            {"kind": "asset_start", "index": 1, "total": 3, "label": "chair"},
            "Starting asset 2/3: chair",
        ),
        (
            {
                "kind": "asset_done",
                "completed": 2,
                "index": 1,
                "total": 3,
                "label": "chair",
            },
            "Generating asset 2/3: chair",
        ),
        ({"kind": "layout"}, "Arranging layout…"),
        ({"kind": "render", "round": 1}, "Amend 1: rendering"),
        (
            {"kind": "blank_warning", "view": "front", "warning": "too dark"},
            "Render warning for front: too dark",
        ),
        (
            {"kind": "critique", "round": 1, "issue_count": 2},
            "Amend 1: 2 issue(s) found",
        ),
        ({"kind": "fix", "round": 1, "issue_count": 2}, "Amend 1: applied fixes"),
        ({"kind": "clean", "round": 1}, "Amend 1: clean"),
        ({"kind": "done", "pass_count": 2}, "Done — 2 pass(es)"),
        ({"kind": "cached"}, "Response served from cache"),
    ]

    for event, expected in cases:
        assert api_generate.format_event(event) == expected

    with pytest.raises(RuntimeError, match="unknown event kind"):
        api_generate.format_event({"kind": "unknown"})


@pytest.mark.asyncio
async def test_post_valid_body_starts_job_and_reaches_done(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(api_generate, "log_event", lambda _event: None)
    monkeypatch.setattr(api_generate, "mirror_run_assets", lambda _result: None)
    monkeypatch.setattr(api_generate, "publish_scene_assets", lambda result: result)

    async def fake_generate(prompt: str, amend_rounds: int, on_event):
        assert prompt == "build a room"
        assert amend_rounds == 0
        on_event({"kind": "plan"})
        await asyncio.sleep(0)
        on_event({"kind": "done", "pass_count": 1})
        return _response()

    monkeypatch.setattr(api_generate, "generate", fake_generate)
    app = FastAPI()
    store = JobStore()
    app.include_router(api_generate.create_generate_router(store))

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        started = await client.post(
            "/api/generate",
            json={"prompt": "build a room", "amendRounds": 0},
        )
        assert started.status_code == 202
        job_id = started.json()["jobId"]

        status = None
        for _ in range(50):
            status = await client.get(f"/api/generate/{job_id}")
            assert status.status_code == 200
            if status.json()["status"] == "done":
                break
            await asyncio.sleep(0.01)

    assert status is not None
    data = status.json()
    assert data["status"] == "done"
    assert data["result"]["passes"][0]["sceneState"]["objects"][0]["glbUrl"] == (
        "/assets/chair.glb"
    )
    assert [line["text"] for line in data["log"]] == [
        "Planning scene…",
        "Done — 1 pass(es)",
    ]


@pytest.mark.asyncio
async def test_invalid_prompt_returns_400_and_unknown_job_returns_404(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    app = FastAPI()
    app.include_router(api_generate.create_generate_router(JobStore()))

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        invalid = await client.post(
            "/api/generate",
            json={"prompt": "  ", "amendRounds": 0},
        )
        missing = await client.get("/api/generate/does-not-exist")

    assert invalid.status_code == 400
    assert missing.status_code == 404
