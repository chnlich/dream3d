"""Tests for pipeline/layout.py."""

import pytest

from pipeline.layout import layout
from scene.schema import PlannedObject, Room, ScenePlan


def _obj(id_: str, label: str, size: tuple[float, float, float], pos: tuple[float, float, float]) -> PlannedObject:
    return PlannedObject(
        id=id_,
        label=label,
        meshy_prompt=f"a {label}",
        approx_size=size,
        position=pos,
        rotation_y_deg=0.0,
    )


def test_layout_drops_object_onto_floor() -> None:
    plan = ScenePlan(
        prompt="test",
        room=Room(width=10.0, depth=10.0, height=3.0),
        objects=[_obj("a", "box", (2.0, 1.0, 2.0), (0.0, 0.0, 0.0))],
    )
    state = layout(plan)
    assert len(state.objects) == 1
    assert state.objects[0].transform.position[1] == pytest.approx(0.5)
    assert state.objects[0].transform.scale == 1.0
    assert state.pass_ == 0


def test_layout_separates_overlapping_objects() -> None:
    # Two 2x1x2 boxes centered at the same spot should be pushed apart.
    plan = ScenePlan(
        prompt="test",
        room=Room(width=10.0, depth=10.0, height=3.0),
        objects=[
            _obj("a", "box a", (2.0, 1.0, 2.0), (0.0, 0.0, 0.0)),
            _obj("b", "box b", (2.0, 1.0, 2.0), (0.0, 0.0, 0.0)),
        ],
    )
    state = layout(plan)
    ax, _, az = state.objects[0].transform.position
    bx, _, bz = state.objects[1].transform.position
    assert (ax, az) != (bx, bz)


def test_layout_keeps_non_overlapping_objects() -> None:
    plan = ScenePlan(
        prompt="test",
        room=Room(width=20.0, depth=20.0, height=3.0),
        objects=[
            _obj("a", "box a", (1.0, 1.0, 1.0), (-5.0, 0.0, 0.0)),
            _obj("b", "box b", (1.0, 1.0, 1.0), (5.0, 0.0, 0.0)),
        ],
    )
    state = layout(plan)
    assert state.objects[0].transform.position[0] == pytest.approx(-5.0)
    assert state.objects[1].transform.position[0] == pytest.approx(5.0)
