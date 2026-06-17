"""Tests for the Python generation orchestrator."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import pytest

from pipeline import orchestrator
from scene.schema import (
    Fix,
    GenerateResponse,
    Pass,
    PlannedObject,
    ReviewIssue,
    Room,
    SceneObject,
    ScenePlan,
    SceneState,
    Transform,
)


class FakeBrowser:
    def __init__(self) -> None:
        self.closed = False

    async def close(self) -> None:
        self.closed = True


@dataclass(frozen=True)
class FakeShot:
    name: str
    png: bytes
    blank_warning: str | None = None


def _plan(count: int = 2) -> ScenePlan:
    return ScenePlan(
        prompt="arrange a studio",
        room=Room(width=6.0, depth=5.0, height=3.0),
        objects=[
            PlannedObject(
                id=f"obj-{i}",
                label=f"object {i}",
                meshy_prompt=f"object {i}",
                approx_size=(1.0, 1.0, 1.0),
                position=(float(i), 0.0, 0.0),
                rotation_y_deg=0.0,
            )
            for i in range(count)
        ],
    )


def _response() -> GenerateResponse:
    obj = SceneObject(
        id="cached",
        label="cached",
        meshy_prompt="cached",
        approx_size=(1.0, 1.0, 1.0),
        transform=Transform(position=(0.0, 0.5, 0.0), rotation_y_deg=0.0, scale=1.0),
        glb_url="/tmp/cached.glb",
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


def _issue(object_id: str) -> ReviewIssue:
    return ReviewIssue(
        object_id=object_id,
        kind="floating",
        severity="medium",
        description="object is floating",
        fix=Fix(op="move", delta=(0.0, -0.1, 0.0)),
        source="geometry",
    )


def _patch_common(
    monkeypatch: pytest.MonkeyPatch,
    plan: ScenePlan,
    *,
    asset_delays: dict[str, float] | None = None,
) -> dict[str, Any]:
    monkeypatch.setenv("DREAM3D_RESPONSE_CACHE", "0")
    monkeypatch.setenv("DREAM3D_PLAN_CACHE", "0")

    calls: dict[str, Any] = {
        "generated": [],
        "captures": 0,
        "reviews": 0,
        "fixes": 0,
        "browser": FakeBrowser(),
    }

    async def fake_plan(_prompt: str) -> ScenePlan:
        return plan

    async def fake_asset(obj: PlannedObject) -> str:
        calls["generated"].append(obj.id)
        if asset_delays is not None:
            await asyncio.sleep(asset_delays.get(obj.id, 0.0))
        return f"/tmp/{obj.id}.glb"

    async def fake_launch_browser() -> FakeBrowser:
        return calls["browser"]

    async def fake_capture_views(_scene, _cameras, *, options):
        calls["captures"] += 1
        assert options["browser"] is calls["browser"]
        return [FakeShot(name="front", png=b"png")]

    async def fake_review(_scene: SceneState, _views: list[dict[str, str]]):
        calls["reviews"] += 1
        return []

    def fake_geometry_check(_scene: SceneState) -> list[ReviewIssue]:
        return []

    def fake_fix(scene: SceneState, _issues: list[ReviewIssue]) -> SceneState:
        calls["fixes"] += 1
        next_scene = scene.model_copy(deep=True)
        next_scene.pass_ = scene.pass_ + 1
        return next_scene

    monkeypatch.setattr(orchestrator.claude_planner, "plan", fake_plan)
    monkeypatch.setattr(orchestrator.asset_provider, "generate", fake_asset)
    monkeypatch.setattr(orchestrator, "launch_browser", fake_launch_browser)
    monkeypatch.setattr(orchestrator, "capture_views", fake_capture_views)
    monkeypatch.setattr(orchestrator.claude_vision_critic, "review", fake_review)
    monkeypatch.setattr(orchestrator, "geometry_check", fake_geometry_check)
    monkeypatch.setattr(orchestrator, "fix", fake_fix)
    return calls


@pytest.mark.asyncio
async def test_amend_rounds_zero_builds_draft_without_render_or_critic(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _patch_common(monkeypatch, _plan(2))
    events: list[dict[str, Any]] = []

    result = await orchestrator.generate("arrange a studio", 0, events.append)

    assert len(result.passes) == 1
    assert [obj.glb_url for obj in result.passes[0].scene_state.objects] == [
        "/tmp/obj-0.glb",
        "/tmp/obj-1.glb",
    ]
    assert calls["captures"] == 0
    assert calls["reviews"] == 0
    assert calls["browser"].closed is True
    assert [event["kind"] for event in events] == [
        "plan",
        "plan_done",
        "asset_start",
        "asset_start",
        "asset_done",
        "asset_done",
        "layout",
        "done",
    ]


@pytest.mark.asyncio
async def test_amend_round_with_issues_renders_critiques_and_fixes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    plan = _plan(1)
    calls = _patch_common(monkeypatch, plan)

    def fake_geometry_check(_scene: SceneState) -> list[ReviewIssue]:
        return [_issue("obj-0")]

    monkeypatch.setattr(orchestrator, "geometry_check", fake_geometry_check)
    events: list[dict[str, Any]] = []

    result = await orchestrator.generate("arrange a studio", 1, events.append)

    assert len(result.passes) == 2
    assert result.passes[1].scene_state.pass_ == 1
    assert calls["captures"] == 1
    assert calls["reviews"] == 1
    assert calls["fixes"] == 1
    kinds = [event["kind"] for event in events]
    assert kinds[kinds.index("render") : kinds.index("fix") + 1] == [
        "render",
        "critique",
        "fix",
    ]


@pytest.mark.asyncio
async def test_clean_amend_round_breaks_without_extra_pass(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _patch_common(monkeypatch, _plan(1))
    events: list[dict[str, Any]] = []

    result = await orchestrator.generate("arrange a studio", 1, events.append)

    assert len(result.passes) == 1
    assert calls["captures"] == 1
    assert calls["reviews"] == 1
    assert calls["fixes"] == 0
    assert [event["kind"] for event in events][-3:] == ["critique", "clean", "done"]


@pytest.mark.asyncio
async def test_response_cache_hit_emits_cached_and_skips_pipeline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cached = _response()
    monkeypatch.delenv("DREAM3D_RESPONSE_CACHE", raising=False)
    monkeypatch.setattr(orchestrator, "derive_response_key", lambda _p, _r: "key")
    monkeypatch.setattr(orchestrator, "read_cached_response", lambda _key: cached)
    monkeypatch.setattr(
        orchestrator,
        "write_cached_response",
        lambda *_args, **_kwargs: pytest.fail("cache hit should not write"),
    )

    async def fail_pipeline(_prompt: str, _rounds: int, _on_event):
        pytest.fail("cache hit should not run the pipeline")

    monkeypatch.setattr(orchestrator, "_run_pipeline", fail_pipeline)
    events: list[dict[str, Any]] = []

    result = await orchestrator.generate("arrange a studio", 1, events.append)

    assert result == cached
    assert events == [{"kind": "cached"}]


@pytest.mark.asyncio
async def test_assets_are_generated_and_applied_in_input_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    plan = _plan(3)
    calls = _patch_common(
        monkeypatch,
        plan,
        asset_delays={"obj-0": 0.03, "obj-1": 0.01, "obj-2": 0.0},
    )

    result = await orchestrator.generate("arrange a studio", 0)

    assert sorted(calls["generated"]) == ["obj-0", "obj-1", "obj-2"]
    assert [obj.glb_url for obj in result.passes[0].scene_state.objects] == [
        "/tmp/obj-0.glb",
        "/tmp/obj-1.glb",
        "/tmp/obj-2.glb",
    ]
