"""Pure camera-framing math for the vision critic's multi-angle capture."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

Vec3 = tuple[float, float, float]


@dataclass(frozen=True)
class CameraSpec:
    name: str
    position: Vec3
    target: Vec3 | None = None
    direction: Vec3 | None = None


ANGLES = (
    ("front", 0.0),
    ("left34", -35.0),
    ("right34", 35.0),
)


def critic_cameras(room: Any) -> list[CameraSpec]:
    width = _field(room, "width")
    depth = _field(room, "depth")
    height = _field(room, "height")
    span = max(width, depth, height)

    elevation = height * 0.85 + span * 0.35
    radius = math.hypot(width * 0.7, depth * 0.95 + span * 0.2)
    target = (0.0, height * 0.3, 0.0)

    cameras: list[CameraSpec] = []
    for name, deg in ANGLES:
        rad = deg * math.pi / 180.0
        position = (radius * math.sin(rad), elevation, radius * math.cos(rad))
        cameras.append(CameraSpec(name=name, position=position, target=target))
    return cameras


def _field(value: Any, name: str) -> float:
    if isinstance(value, dict):
        return float(value[name])
    return float(getattr(value, name))
