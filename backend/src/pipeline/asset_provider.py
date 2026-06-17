"""Cache-aware Meshy asset provider for Dream3D."""

import time

from config import load_config
from log.audit import log_event
from meshy.cache import (
    DEFAULT_CACHE_DIR,
    derive_key,
    ensure_dir_meta,
    normalize_prompt,
    read_index,
    select_candidate,
    serialize_cache,
    valid_candidates_on_disk,
    write_index,
)
from meshy.client import create_meshy_client
from meshy.gen_params import PREVIEW_PARAMS, REFINE_PARAMS, param_signature
from scene.schema import PlannedObject

POLL_INTERVAL_MS = 6000
TIMEOUT_MS = 5 * 60 * 1000


async def generate(obj: PlannedObject) -> str:
    mode = "refine"
    cache_dir = DEFAULT_CACHE_DIR
    key = derive_key(obj.meshy_prompt, mode, param_signature(mode))
    normalized = normalize_prompt(obj.meshy_prompt)

    index = read_index(cache_dir)
    cached = index.get(key)
    if cached and len(valid_candidates_on_disk(cached["candidates"])) > 0:
        ensure_dir_meta(
            cache_dir,
            key,
            prompt=obj.meshy_prompt,
            normalized_prompt=normalized,
            mode=mode,
        )
        chosen = select_candidate(cached)
        glb = chosen.get("glb")
        if not isinstance(glb, str):
            raise RuntimeError(
                f"Cache hit for {key} but selected candidate {chosen['taskId']} has no .glb on disk"
            )
        log_event({"kind": "meshy.cache_hit", "objId": obj.id, "key": key, "glb": glb})
        return glb

    log_event({"kind": "meshy.cache_miss", "objId": obj.id, "key": key})
    client = create_meshy_client(load_config().meshy_api_key)
    preview_task_id = await client.submit_preview(obj.meshy_prompt, PREVIEW_PARAMS)
    log_event({"kind": "meshy.preview_submit", "objId": obj.id, "taskId": preview_task_id})
    await client.wait_for_task(
        preview_task_id,
        poll_interval_ms=POLL_INTERVAL_MS,
        timeout_ms=TIMEOUT_MS,
    )
    refine_task_id = await client.submit_refine(preview_task_id, REFINE_PARAMS)
    log_event(
        {
            "kind": "meshy.refine_submit",
            "objId": obj.id,
            "previewTaskId": preview_task_id,
            "refineTaskId": refine_task_id,
        }
    )
    refined = await client.wait_for_task(
        refine_task_id,
        poll_interval_ms=POLL_INTERVAL_MS,
        timeout_ms=TIMEOUT_MS,
    )
    glb_url = refined.model_urls["glb"]
    if not glb_url:
        raise RuntimeError(f"Meshy refine task {refined.id} SUCCEEDED without model_urls.glb")
    data = await client.download_glb(glb_url)
    log_event(
        {
            "kind": "meshy.done",
            "objId": obj.id,
            "taskId": refine_task_id,
            "status": refined.status,
            "bytes": len(data),
        }
    )

    directory = cache_dir / key
    directory.mkdir(parents=True, exist_ok=True)
    glb_path = directory / f"{refine_task_id}.glb"
    glb_path.write_bytes(data)

    candidate = {
        "taskId": refine_task_id,
        "prompt": obj.meshy_prompt,
        "mode": mode,
        "key": key,
        "status": refined.status,
        "savedAt": int(time.time()),
        "glb": str(glb_path),
        "bytes": len(data),
    }
    (directory / f"{refine_task_id}.json").write_text(
        serialize_cache(candidate), encoding="utf-8"
    )

    entry = index.get(key) or {
        "prompt": obj.meshy_prompt,
        "mode": mode,
        "key": key,
        "winner": None,
        "candidates": [],
    }
    entry["candidates"].append(candidate)
    index[key] = entry
    write_index(cache_dir, index)
    ensure_dir_meta(
        cache_dir,
        key,
        prompt=obj.meshy_prompt,
        normalized_prompt=normalized,
        mode=mode,
    )
    return str(glb_path)
