"""Plan-level cache for the Dream3D pipeline planner."""

import os
from collections.abc import Awaitable, Callable
from typing import Any

from meshy.cache import normalize_prompt
from pipeline.disk_cache import create_disk_cache
from scene.schema import ScenePlan

PLAN_CACHE_VERSION = 1


def _validate_plan(value: Any, path: str) -> bool:
    if not isinstance(value, dict) or not isinstance(value.get("objects"), list):
        raise RuntimeError(
            f'Corrupt plan cache {path}: "plan" is not an object with an "objects" array'
        )
    return True


cache = create_disk_cache(
    dir_name="plans",
    label="plan",
    value_key="plan",
    version=PLAN_CACHE_VERSION,
    validate=_validate_plan,
)


def derive_plan_key(prompt: str) -> str:
    return cache.derive_key([normalize_prompt(prompt)])


def read_cached_plan(key: str) -> ScenePlan | None:
    value = cache.read(key)
    if value is None:
        return None
    return ScenePlan.model_validate(value)


def write_cached_plan(key: str, *, prompt: str, plan: ScenePlan) -> None:
    cache.write(
        key,
        {"prompt": prompt, "normalizedPrompt": normalize_prompt(prompt)},
        plan.model_dump(by_alias=True),
    )


async def get_or_create_plan(
    prompt: str,
    plan_fn: Callable[[], Awaitable[ScenePlan]],
) -> ScenePlan:
    if os.environ.get("DREAM3D_PLAN_CACHE") == "0":
        return await plan_fn()

    key = derive_plan_key(prompt)
    cached = read_cached_plan(key)
    if cached is not None:
        print(f"[dream3d] plan cache HIT {key}")
        return cached

    plan = await plan_fn()
    write_cached_plan(key, prompt=prompt, plan=plan)
    return plan
