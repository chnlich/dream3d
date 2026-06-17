"""Tests for the Claude-backed scene planner."""

import asyncio
import copy
import json

import pytest

from pipeline import claude_planner
from scene.schema import ScenePlan


def _valid_payload() -> dict:
    return {
        "room": {"width": 5.0, "depth": 4.0, "height": 3.0},
        "objects": [
            {
                "id": "sofa-1",
                "label": "Sofa",
                "meshyPrompt": "isolated modern gray fabric sofa",
                "approxSize": [2.0, 0.8, 0.9],
                "position": [0.0, 0.4, 0.0],
                "rotationYDeg": 0.0,
            },
            {
                "id": "table-1",
                "label": "Coffee table",
                "meshyPrompt": "isolated low walnut coffee table",
                "approxSize": [1.0, 0.4, 0.6],
                "position": [0.0, 0.2, 1.0],
                "rotationYDeg": 0.0,
            },
            {
                "id": "lamp-1",
                "label": "Floor lamp",
                "meshyPrompt": "isolated slim brass floor lamp with shade",
                "approxSize": [0.4, 1.6, 0.4],
                "position": [1.5, 0.8, -0.8],
                "rotationYDeg": 15.0,
            },
        ],
    }


def _json(payload: dict) -> str:
    return json.dumps(payload)


def test_plan_valid_json_builds_scene_plan(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict] = []

    def fake_run_claude(prompt: str, *, caller: str) -> str:
        calls.append({"prompt": prompt, "caller": caller})
        return _json(_valid_payload())

    monkeypatch.setattr(claude_planner, "run_claude", fake_run_claude)

    result = asyncio.run(claude_planner.plan("  cozy reading room  "))

    assert isinstance(result, ScenePlan)
    assert result.prompt == "  cozy reading room  "
    assert result.objects[0].meshy_prompt == "isolated modern gray fabric sofa"
    assert calls[0]["caller"] == "planner"
    assert "Scene description: cozy reading room" in calls[0]["prompt"]


def test_plan_strips_json_fence(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        claude_planner,
        "run_claude",
        lambda _prompt, *, caller: f"```json\n{_json(_valid_payload())}\n```",
    )

    result = asyncio.run(claude_planner.plan("cozy room"))

    assert len(result.objects) == 3


@pytest.mark.parametrize("count", [2, 7])
def test_plan_object_count_out_of_range_raises(
    count: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = _valid_payload()
    payload["objects"] = (payload["objects"] * 3)[:count]
    for i, obj in enumerate(payload["objects"]):
        obj["id"] = f"obj-{i}"
    monkeypatch.setattr(
        claude_planner, "run_claude", lambda _prompt, *, caller: _json(payload)
    )

    with pytest.raises(ValueError, match="expected 3-6 objects"):
        asyncio.run(claude_planner.plan("cozy room"))


def test_plan_duplicate_id_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    payload = _valid_payload()
    payload["objects"][1]["id"] = payload["objects"][0]["id"]
    monkeypatch.setattr(
        claude_planner, "run_claude", lambda _prompt, *, caller: _json(payload)
    )

    with pytest.raises(ValueError, match="duplicate object id"):
        asyncio.run(claude_planner.plan("cozy room"))


def test_plan_non_finite_number_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    payload = _valid_payload()
    payload["objects"][0]["rotationYDeg"] = float("inf")
    monkeypatch.setattr(
        claude_planner, "run_claude", lambda _prompt, *, caller: _json(payload)
    )

    with pytest.raises(ValueError, match="finite number"):
        asyncio.run(claude_planner.plan("cozy room"))


def test_plan_wrong_vec_length_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    payload = copy.deepcopy(_valid_payload())
    payload["objects"][0]["approxSize"] = [1.0, 2.0]
    monkeypatch.setattr(
        claude_planner, "run_claude", lambda _prompt, *, caller: _json(payload)
    )

    with pytest.raises(ValueError, match=r"\[x, y, z\] array"):
        asyncio.run(claude_planner.plan("cozy room"))


def test_plan_empty_prompt_raises() -> None:
    with pytest.raises(ValueError, match="prompt must be a non-empty string"):
        asyncio.run(claude_planner.plan("   "))
