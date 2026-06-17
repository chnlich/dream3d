"""Cache-aware Dream3D generation orchestrator."""

from __future__ import annotations

import asyncio
import base64
import os
from collections.abc import Callable
from typing import Any

from log.audit import current_run_id
from pipeline import asset_provider, claude_planner, claude_vision_critic
from pipeline.fix import fix
from pipeline.geometry_check import geometry_check
from pipeline.layout import layout
from pipeline.plan_cache import get_or_create_plan
from pipeline.response_cache import (
    derive_response_key,
    read_cached_response,
    write_cached_response,
)
from render.critic_cameras import critic_cameras
from render.headless import launch_browser
from render.multiangle import capture_views
from scene.schema import GenerateResponse, Pass, PlannedObject, SceneState

ASSET_CONCURRENCY = 20

ProgressCallback = Callable[[dict[str, Any]], None]


async def generate(
    prompt: str,
    amend_rounds: int,
    on_event: ProgressCallback | None = None,
) -> GenerateResponse:
    """Run the full generation pipeline, using the response cache when enabled."""
    use_cache = os.environ.get("DREAM3D_RESPONSE_CACHE") != "0"
    if use_cache:
        key = derive_response_key(prompt, amend_rounds)
        cached = read_cached_response(key)
        if cached is not None:
            print(f"[dream3d] response cache HIT {key} (amendRounds={amend_rounds})")
            _emit(on_event, {"kind": "cached"})
            return GenerateResponse.model_validate(cached.model_dump(by_alias=True))

        result = await _run_pipeline(prompt, amend_rounds, on_event)
        write_cached_response(
            key,
            prompt=prompt,
            amend_rounds=amend_rounds,
            response=result,
        )
        return result

    return await _run_pipeline(prompt, amend_rounds, on_event)


async def _run_pipeline(
    prompt: str,
    amend_rounds: int,
    on_event: ProgressCallback | None,
) -> GenerateResponse:
    _emit(on_event, {"kind": "plan"})
    plan = await get_or_create_plan(prompt, lambda: claude_planner.plan(prompt))
    _emit(on_event, {"kind": "plan_done", "object_count": len(plan.objects)})

    paths = await _generate_assets(plan.objects, on_event)

    scene = layout(plan)
    _emit(on_event, {"kind": "layout"})
    for index, obj in enumerate(scene.objects):
        obj.glb_url = paths[index]
        obj.status = "ready"

    passes = [Pass(scene_state=scene.model_copy(deep=True))]

    browser = await launch_browser()
    try:
        for round_ in range(1, amend_rounds + 1):
            _emit(on_event, {"kind": "render", "round": round_})
            views = await _capture_scene_views(scene, browser, on_event)
            issues = geometry_check(scene) + await claude_vision_critic.review(
                scene, views
            )
            _emit(
                on_event,
                {"kind": "critique", "round": round_, "issue_count": len(issues)},
            )
            if len(issues) == 0:
                _emit(on_event, {"kind": "clean", "round": round_})
                break
            scene = fix(scene, issues)
            _emit(
                on_event,
                {"kind": "fix", "round": round_, "issue_count": len(issues)},
            )
            passes.append(Pass(scene_state=scene.model_copy(deep=True)))
    finally:
        await browser.close()

    _emit(on_event, {"kind": "done", "pass_count": len(passes)})
    return GenerateResponse(passes=passes)


async def _generate_assets(
    objects: list[PlannedObject],
    on_event: ProgressCallback | None,
) -> list[str]:
    semaphore = asyncio.Semaphore(ASSET_CONCURRENCY)
    total = len(objects)
    completed = 0

    async def generate_one(index: int, obj: PlannedObject) -> str:
        nonlocal completed
        async with semaphore:
            _emit(
                on_event,
                {
                    "kind": "asset_start",
                    "index": index,
                    "total": total,
                    "label": obj.label,
                },
            )
            await asyncio.sleep(0)
            path = await asset_provider.generate(obj)
            completed += 1
            _emit(
                on_event,
                {
                    "kind": "asset_done",
                    "index": index,
                    "total": total,
                    "completed": completed,
                    "label": obj.label,
                },
            )
            return path

    return await asyncio.gather(
        *(generate_one(index, obj) for index, obj in enumerate(objects))
    )


async def _capture_scene_views(
    scene: SceneState,
    browser: Any,
    on_event: ProgressCallback | None,
) -> list[dict[str, str]]:
    shots = await capture_views(
        _to_render_input(scene),
        critic_cameras(scene.room),
        options={"browser": browser, "job_id": current_run_id()},
    )
    for shot in shots:
        if shot.blank_warning:
            _emit(
                on_event,
                {
                    "kind": "blank_warning",
                    "view": shot.name,
                    "warning": shot.blank_warning,
                },
            )
    return [
        {
            "name": shot.name,
            "dataUrl": "data:image/png;base64,"
            + base64.b64encode(shot.png).decode("ascii"),
        }
        for shot in shots
    ]


def _to_render_input(scene: SceneState) -> dict[str, Any]:
    return {
        "room": scene.room.model_dump(),
        "objects": [
            {
                "glbUrl": obj.glb_url,
                "primitive": "box" if not obj.glb_url else None,
                "position": obj.transform.position,
                "rotationYDeg": obj.transform.rotation_y_deg,
                "scale": obj.transform.scale,
                "approxSize": obj.approx_size,
            }
            for obj in scene.objects
        ],
    }


def _emit(on_event: ProgressCallback | None, event: dict[str, Any]) -> None:
    if on_event is not None:
        on_event(event)
