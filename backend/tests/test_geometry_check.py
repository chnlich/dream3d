"""Tests for pipeline/geometry_check.py."""

import pytest

from pipeline.geometry_check import geometry_check
from scene.schema import Room, SceneObject, SceneState, Transform


def _scene_object(
    id_: str,
    label: str,
    size: tuple[float, float, float],
    position: tuple[float, float, float],
) -> SceneObject:
    return SceneObject(
        id=id_,
        label=label,
        meshy_prompt=f"a {label}",
        approx_size=size,
        transform=Transform(position=position, rotation_y_deg=0.0, scale=1.0),
        status="pending",
    )


def test_no_issues_for_valid_floor_resting_object() -> None:
    state = SceneState(
        room=Room(width=10.0, depth=10.0, height=3.0),
        objects=[_scene_object("a", "box", (2.0, 1.0, 2.0), (0.0, 0.5, 0.0))],
        pass_=0,
    )
    issues = geometry_check(state)
    assert issues == []


def test_detects_floating_object() -> None:
    state = SceneState(
        room=Room(width=10.0, depth=10.0, height=3.0),
        objects=[_scene_object("a", "box", (2.0, 1.0, 2.0), (0.0, 1.5, 0.0))],
        pass_=0,
    )
    issues = geometry_check(state)
    assert len(issues) == 1
    assert issues[0].kind == "floating"
    assert issues[0].fix.op == "move"
    assert issues[0].fix.delta == pytest.approx((0.0, -1.0, 0.0))


def test_detects_out_of_bounds() -> None:
    state = SceneState(
        room=Room(width=4.0, depth=4.0, height=2.0),
        objects=[_scene_object("a", "box", (2.0, 1.0, 2.0), (2.0, 0.5, 0.0))],
        pass_=0,
    )
    issues = geometry_check(state)
    assert any(issue.kind == "out_of_bounds" for issue in issues)


def test_detects_overlap() -> None:
    state = SceneState(
        room=Room(width=10.0, depth=10.0, height=3.0),
        objects=[
            _scene_object("a", "box a", (2.0, 1.0, 2.0), (0.0, 0.5, 0.0)),
            _scene_object("b", "box b", (2.0, 1.0, 2.0), (0.0, 0.5, 0.0)),
        ],
        pass_=0,
    )
    issues = geometry_check(state)
    overlap_issues = [issue for issue in issues if issue.kind == "overlap"]
    assert len(overlap_issues) == 1
    assert overlap_issues[0].object_id == "b"
    assert overlap_issues[0].fix.op == "move"
