"""Pure-geometry review pass for SceneState.

Mirrors src/pipeline/geometryCheck.ts. Flags floating objects, objects outside
room bounds, and overlapping footprints. Each issue carries a deterministic move
Fix that resolves it.
"""

from scene.bbox import footprint_penetration, half_extents
from scene.schema import ReviewIssue, SceneObject, SceneState, Vec3

FLOOR_TOLERANCE = 0.05


def geometry_check(scene: SceneState) -> list[ReviewIssue]:
    """Return geometry issues found in the given scene state."""
    issues: list[ReviewIssue] = []
    half_width = scene.room.width / 2
    half_depth = scene.room.depth / 2

    for obj in scene.objects:
        half = half_extents(obj)
        x, y, z = obj.transform.position

        rest_y = half[1]
        if abs(y - rest_y) > FLOOR_TOLERANCE:
            issues.append(
                ReviewIssue(
                    object_id=obj.id,
                    kind="floating",
                    severity="medium",
                    description=f"{obj.label} sits {(y - rest_y):.2f}m off the floor",
                    fix={"op": "move", "delta": (0.0, rest_y - y, 0.0)},
                    source="geometry",
                )
            )

        overflow_x = _axis_overflow(x, half[0], half_width)
        overflow_z = _axis_overflow(z, half[2], half_depth)
        overflow_ceiling = max(0.0, y + half[1] - scene.room.height)
        if overflow_x != 0 or overflow_z != 0 or overflow_ceiling > 0:
            issues.append(
                ReviewIssue(
                    object_id=obj.id,
                    kind="out_of_bounds",
                    severity="high",
                    description=f"{obj.label} extends outside the room",
                    fix={
                        "op": "move",
                        "delta": (-overflow_x, -overflow_ceiling, -overflow_z),
                    },
                    source="geometry",
                )
            )

    for i in range(len(scene.objects)):
        for j in range(i + 1, len(scene.objects)):
            issue = _overlap_issue(scene.objects[i], scene.objects[j])
            if issue is not None:
                issues.append(issue)

    return issues


def _axis_overflow(center: float, half: float, bound: float) -> float:
    """Signed amount the span pokes past [-bound, bound]."""
    max_ = center + half
    min_ = center - half
    if max_ > bound:
        return max_ - bound
    if min_ < -bound:
        return min_ + bound
    return 0.0


def _overlap_issue(a: SceneObject, b: SceneObject) -> ReviewIssue | None:
    penetration = footprint_penetration(a, b)
    penetration_x = penetration["x"]
    penetration_z = penetration["z"]
    if penetration_x <= 0 or penetration_z <= 0:
        return None

    ax, _, az = a.transform.position
    bx, _, bz = b.transform.position
    if penetration_x <= penetration_z:
        dir_ = 1 if bx == ax else (1 if bx - ax > 0 else -1)
        delta: Vec3 = (penetration_x * dir_, 0.0, 0.0)
    else:
        dir_ = 1 if bz == az else (1 if bz - az > 0 else -1)
        delta = (0.0, 0.0, penetration_z * dir_)

    return ReviewIssue(
        object_id=b.id,
        kind="overlap",
        severity="medium",
        description=f"{b.label} overlaps {a.label}",
        fix={"op": "move", "delta": delta},
        source="geometry",
    )
