"""Tests for the Claude-backed vision critic."""

import asyncio
import base64
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from pipeline import claude_vision_critic
from scene.schema import Room, SceneObject, SceneState, Transform


def _scene() -> SceneState:
    return SceneState(
        room=Room(width=5.0, depth=4.0, height=3.0),
        pass_=1,
        objects=[
            SceneObject(
                id="chair-1",
                label="Chair",
                meshyPrompt="isolated wooden dining chair",
                approxSize=(0.5, 0.9, 0.5),
                transform=Transform(
                    position=(0.0, 0.45, 0.0),
                    rotationYDeg=0.0,
                    scale=1.0,
                ),
                glbUrl="/assets/chair.glb",
                status="ready",
            )
        ],
    )


def _view(media_type: str = "image/png") -> dict[str, str]:
    data = base64.b64encode(b"image-bytes").decode("ascii")
    return {"name": "front", "dataUrl": f"data:{media_type};base64,{data}"}


def _issues_payload(fix: dict | None = None, **overrides: str) -> dict:
    return {
        "issues": [
            {
                "objectId": overrides.get("objectId", "chair-1"),
                "kind": overrides.get("kind", "overlap"),
                "severity": overrides.get("severity", "medium"),
                "description": "The chair intersects another object.",
                "fix": fix or {"op": "move", "delta": [0.1, 0.0, 0.0]},
            }
        ]
    }


def test_review_parses_issues(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = SimpleNamespace(paths=None, prompt=None)

    def fake_run_claude(prompt: str, *, image_paths: list[str], caller: str) -> str:
        seen.paths = image_paths
        seen.prompt = prompt
        assert caller == "vision-critic"
        assert len(image_paths) == 1
        assert Path(image_paths[0]).exists()
        return json.dumps(_issues_payload())

    monkeypatch.setattr(claude_vision_critic, "run_claude", fake_run_claude)

    issues = asyncio.run(claude_vision_critic.review(_scene(), [_view()]))

    assert issues[0].object_id == "chair-1"
    assert issues[0].source == "vision"
    assert issues[0].fix.delta == (0.1, 0.0, 0.0)
    assert "Layout JSON:" in seen.prompt
    assert not Path(seen.paths[0]).parent.exists()


def test_review_empty_views_raises() -> None:
    with pytest.raises(ValueError, match="requires at least one rendered view"):
        asyncio.run(claude_vision_critic.review(_scene(), []))


def test_review_unknown_object_id_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        claude_vision_critic,
        "run_claude",
        lambda _prompt, *, image_paths, caller: json.dumps(
            _issues_payload(objectId="missing")
        ),
    )

    with pytest.raises(ValueError, match="is not in the scene"):
        asyncio.run(claude_vision_critic.review(_scene(), [_view()]))


def test_review_salvages_prose_wrapped_json(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        claude_vision_critic,
        "run_claude",
        lambda _prompt, *, image_paths, caller: (
            f"Here is the result:\n{json.dumps({'issues': []})}\nDone."
        ),
    )

    assert asyncio.run(claude_vision_critic.review(_scene(), [_view()])) == []


@pytest.mark.parametrize(
    ("fix", "field", "expected"),
    [
        ({"op": "move", "delta": [0.1, 0.2, 0.3]}, "delta", (0.1, 0.2, 0.3)),
        ({"op": "rotate", "rotationYDeg": 45.0}, "rotation_y_deg", 45.0),
        ({"op": "resize", "scaleFactor": 0.8}, "scale_factor", 0.8),
    ],
)
def test_review_dispatches_each_fix_op(
    fix: dict, field: str, expected: object, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        claude_vision_critic,
        "run_claude",
        lambda _prompt, *, image_paths, caller: json.dumps(_issues_payload(fix)),
    )

    issue = asyncio.run(claude_vision_critic.review(_scene(), [_view()]))[0]

    assert getattr(issue.fix, field) == expected


@pytest.mark.parametrize(
    "overrides,match",
    [
        ({"kind": "other"}, "issues\\[0\\].kind"),
        ({"severity": "critical"}, "issues\\[0\\].severity"),
    ],
)
def test_review_bad_kind_or_severity_raises(
    overrides: dict, match: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        claude_vision_critic,
        "run_claude",
        lambda _prompt, *, image_paths, caller: json.dumps(_issues_payload(**overrides)),
    )

    with pytest.raises(ValueError, match=match):
        asyncio.run(claude_vision_critic.review(_scene(), [_view()]))


def test_review_removes_temp_dir_when_claude_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    temp_dir = tmp_path / "critic-temp"

    def fake_mkdtemp(*, prefix: str) -> str:
        temp_dir.mkdir()
        return str(temp_dir)

    def fake_run_claude(
        _prompt: str, *, image_paths: list[str], caller: str
    ) -> str:
        assert Path(image_paths[0]).exists()
        raise RuntimeError("claude failed")

    monkeypatch.setattr(claude_vision_critic.tempfile, "mkdtemp", fake_mkdtemp)
    monkeypatch.setattr(claude_vision_critic, "run_claude", fake_run_claude)

    with pytest.raises(RuntimeError, match="claude failed"):
        asyncio.run(claude_vision_critic.review(_scene(), [_view()]))

    assert not temp_dir.exists()


def test_review_accepts_image_jpg_data_url(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = SimpleNamespace(path=None)

    def fake_run_claude(_prompt: str, *, image_paths: list[str], caller: str) -> str:
        seen.path = image_paths[0]
        return json.dumps({"issues": []})

    monkeypatch.setattr(claude_vision_critic, "run_claude", fake_run_claude)

    assert asyncio.run(claude_vision_critic.review(_scene(), [_view("image/jpg")])) == []
    assert seen.path.endswith(".jpg")
