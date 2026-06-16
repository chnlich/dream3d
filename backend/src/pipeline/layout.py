"""Deterministic layout pass: ScenePlan -> initial SceneState (pass 0).

Mirrors src/pipeline/layout.ts. Position is the object CENTER in world space,
the floor is y=0, and scale is kept at 1. Objects are dropped onto the floor,
then overlapping footprints are nudged apart.
"""

from scene.bbox import footprint_penetration
from scene.schema import PlannedObject, SceneObject, ScenePlan, SceneState, Transform

MAX_NUDGE_ITERATIONS = 24


def layout(plan: ScenePlan) -> SceneState:
    """Build an initial SceneState from a ScenePlan."""
    objects: list[SceneObject] = []
    for obj in plan.objects:
        scene_obj = _planned_to_scene_object(obj)
        objects.append(scene_obj)

    _separate_overlaps(objects)

    return SceneState(room=plan.room, objects=objects, pass_=0)


def _planned_to_scene_object(obj: PlannedObject) -> SceneObject:
    return SceneObject(
        id=obj.id,
        label=obj.label,
        meshy_prompt=obj.meshy_prompt,
        approx_size=obj.approx_size,
        transform=Transform(
            position=(obj.position[0], obj.approx_size[1] / 2, obj.position[2]),
            rotation_y_deg=obj.rotation_y_deg,
            scale=1.0,
        ),
        status="pending",
    )


def _separate_overlaps(objects: list[SceneObject]) -> None:
    for _iteration in range(MAX_NUDGE_ITERATIONS):
        moved = False
        for i in range(len(objects)):
            for j in range(i + 1, len(objects)):
                if _push_apart(objects[i], objects[j]):
                    moved = True
        if not moved:
            break


def _push_apart(a: SceneObject, b: SceneObject) -> bool:
    penetration = footprint_penetration(a, b)
    penetration_x = penetration["x"]
    penetration_z = penetration["z"]
    if penetration_x <= 0 or penetration_z <= 0:
        return False

    ax, _, az = a.transform.position
    bx, _, bz = b.transform.position
    if penetration_x <= penetration_z:
        dir_ = -1 if ax == bx else (1 if ax - bx > 0 else -1)
        shift = (penetration_x / 2) * dir_
        a.transform.position = (ax + shift, a.transform.position[1], az)
        b.transform.position = (bx - shift, b.transform.position[1], bz)
    else:
        dir_ = -1 if az == bz else (1 if az - bz > 0 else -1)
        shift = (penetration_z / 2) * dir_
        a.transform.position = (ax, a.transform.position[1], az + shift)
        b.transform.position = (bx, b.transform.position[1], bz - shift)
    return True
