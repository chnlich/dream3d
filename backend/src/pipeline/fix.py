"""Apply review fixes to a scene, producing the next-pass SceneState.

Mirrors src/pipeline/fix.ts. Works on a deep clone so the caller's scene is
never mutated, then bumps `pass`.
"""

from scene.schema import Fix, ReviewIssue, SceneObject, SceneState


def fix(scene: SceneState, issues: list[ReviewIssue]) -> SceneState:
    """Apply fixes to a deep copy of the scene and return the next pass state."""
    next_state = scene.model_copy(deep=True)
    for issue in issues:
        obj = _find_object(next_state, issue.object_id)
        if obj is None:
            raise RuntimeError(f"fix: issue targets unknown object '{issue.object_id}'")
        _apply_fix(obj, issue)
    next_state.pass_ = scene.pass_ + 1
    return next_state


def _find_object(state: SceneState, object_id: str) -> SceneObject | None:
    for obj in state.objects:
        if obj.id == object_id:
            return obj
    return None


def _apply_fix(obj: SceneObject, issue: ReviewIssue) -> None:
    f: Fix = issue.fix
    op = f.op
    if op == "move":
        if f.delta is None:
            raise RuntimeError(f'fix: "move" on "{issue.object_id}" is missing delta')
        px, py, pz = obj.transform.position
        obj.transform.position = (
            px + f.delta[0],
            py + f.delta[1],
            pz + f.delta[2],
        )
    elif op == "rotate":
        if f.rotation_y_deg is None:
            raise RuntimeError(
                f'fix: "rotate" on "{issue.object_id}" is missing rotationYDeg'
            )
        obj.transform.rotation_y_deg += f.rotation_y_deg
    elif op == "resize":
        if f.scale_factor is None:
            raise RuntimeError(
                f'fix: "resize" on "{issue.object_id}" is missing scaleFactor'
            )
        obj.transform.scale *= f.scale_factor
        # Re-seat on the floor at the new scale.
        obj.transform.position = (
            obj.transform.position[0],
            (obj.approx_size[1] * obj.transform.scale) / 2,
            obj.transform.position[2],
        )
    elif op == "regenerate":
        if f.new_meshy_prompt is not None:
            obj.meshy_prompt = f.new_meshy_prompt
        obj.glb_url = None
        obj.status = "pending"
    else:
        raise RuntimeError(f'fix: unknown op "{op}" on "{issue.object_id}"')
