"""Tests for pipeline/fix.py."""

import pytest

from pipeline.fix import fix
from scene.schema import Fix, ReviewIssue, Room, SceneObject, SceneState, Transform


def _scene(
    position: tuple[float, float, float] = (0.0, 0.5, 0.0),
    scale: float = 1.0,
) -> SceneState:
    return SceneState(
        room=Room(width=10.0, depth=10.0, height=3.0),
        objects=[
            SceneObject(
                id="a",
                label="box",
                meshy_prompt="a box",
                approx_size=(1.0, 1.0, 1.0),
                transform=Transform(
                    position=position, rotation_y_deg=0.0, scale=scale
                ),
                status="ready",
            )
        ],
        pass_=0,
    )


def test_move_fix() -> None:
    scene = _scene()
    issues = [
        ReviewIssue(
            object_id="a",
            kind="floating",
            severity="medium",
            description="floating",
            fix=Fix(op="move", delta=(1.0, 0.5, -1.0)),
            source="geometry",
        )
    ]
    next_state = fix(scene, issues)
    assert next_state.pass_ == 1
    assert next_state.objects[0].transform.position == pytest.approx((1.0, 1.0, -1.0))
    # Original scene is not mutated.
    assert scene.objects[0].transform.position == pytest.approx((0.0, 0.5, 0.0))


def test_rotate_fix() -> None:
    scene = _scene()
    issues = [
        ReviewIssue(
            object_id="a",
            kind="wrong_facing",
            severity="low",
            description="wrong facing",
            fix=Fix(op="rotate", rotation_y_deg=90.0),
            source="geometry",
        )
    ]
    next_state = fix(scene, issues)
    assert next_state.objects[0].transform.rotation_y_deg == pytest.approx(90.0)


def test_resize_fix_reseats_on_floor() -> None:
    scene = _scene(scale=1.0)
    issues = [
        ReviewIssue(
            object_id="a",
            kind="too_small",
            severity="medium",
            description="too small",
            fix=Fix(op="resize", scale_factor=2.0),
            source="geometry",
        )
    ]
    next_state = fix(scene, issues)
    assert next_state.objects[0].transform.scale == pytest.approx(2.0)
    # Center height should be half the scaled height.
    assert next_state.objects[0].transform.position[1] == pytest.approx(1.0)


def test_regenerate_fix() -> None:
    scene = _scene()
    issues = [
        ReviewIssue(
            object_id="a",
            kind="other",
            severity="high",
            description="bad asset",
            fix=Fix(op="regenerate", new_meshy_prompt="a better box"),
            source="vision",
        )
    ]
    next_state = fix(scene, issues)
    assert next_state.objects[0].meshy_prompt == "a better box"
    assert next_state.objects[0].glb_url is None
    assert next_state.objects[0].status == "pending"


def test_fix_unknown_object_raises() -> None:
    scene = _scene()
    issues = [
        ReviewIssue(
            object_id="missing",
            kind="floating",
            severity="medium",
            description="missing",
            fix=Fix(op="move", delta=(0.0, 0.0, 0.0)),
            source="geometry",
        )
    ]
    with pytest.raises(RuntimeError):
        fix(scene, issues)


def test_move_fix_missing_delta_raises() -> None:
    scene = _scene()
    issues = [
        ReviewIssue(
            object_id="a",
            kind="floating",
            severity="medium",
            description="floating",
            fix=Fix(op="move"),
            source="geometry",
        )
    ]
    with pytest.raises(RuntimeError):
        fix(scene, issues)
