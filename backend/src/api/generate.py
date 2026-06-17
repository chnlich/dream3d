"""Generate routes for the Python backend.

POST /api/generate starts a background generation job.
GET /api/generate/<jobId> returns the current JobStatus.
"""

import asyncio
import logging
import time
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException

from log.audit import log_event, mirror_run_assets, with_run
from pipeline.orchestrator import generate
from scene.schema import (
    GenerateRequest,
    JobStartResponse,
    JobStatus,
    LogLine,
)
from server.asset_bridge import publish_scene_assets
from server.job_store import JobStore

logger = logging.getLogger(__name__)


def _now_ms() -> int:
    return int(time.time() * 1000)


async def _run(
    job_id: str, prompt: str, amend_rounds: int, store: JobStore
) -> None:
    job = store.get(job_id)
    if job is None:
        raise RuntimeError(f"job {job_id} disappeared from store")

    with with_run(job_id):

        def on_event(ev: dict[str, Any]) -> None:
            if ev["kind"] == "cached":
                job.cached = True
            job.log.append(LogLine(ts=_now_ms(), text=format_event(ev)))
            log_event(ev)
            store.persist(job_id, job)

        try:
            result = await generate(prompt, amend_rounds, on_event)
            job.status = "done"
            mirror_run_assets(result)
            job.result = publish_scene_assets(result)
            store.persist(job_id, job)
        except Exception as exc:  # noqa: BLE001
            job.status = "error"
            job.error = str(exc)
            logger.error("job failed: %s", exc, exc_info=True)
            store.persist(job_id, job)


def format_event(ev: dict[str, Any]) -> str:
    kind = ev["kind"]
    if kind == "plan":
        return "Planning scene…"
    if kind == "plan_done":
        return f"Plan ready — {ev['object_count']} object(s)"
    if kind == "asset_start":
        return f"Starting asset {ev['index'] + 1}/{ev['total']}: {ev['label']}"
    if kind == "asset_done":
        return f"Generating asset {ev['completed']}/{ev['total']}: {ev['label']}"
    if kind == "layout":
        return "Arranging layout…"
    if kind == "render":
        return f"Amend {ev['round']}: rendering"
    if kind == "blank_warning":
        return f"Render warning for {ev['view']}: {ev['warning']}"
    if kind == "critique":
        return f"Amend {ev['round']}: {ev['issue_count']} issue(s) found"
    if kind == "fix":
        return f"Amend {ev['round']}: applied fixes"
    if kind == "clean":
        return f"Amend {ev['round']}: clean"
    if kind == "done":
        return f"Done — {ev['pass_count']} pass(es)"
    if kind == "cached":
        return "Response served from cache"
    raise RuntimeError(f'unknown event kind "{kind}"')


def create_generate_router(store: JobStore) -> APIRouter:
    """Factory that returns the generate router bound to a JobStore instance."""
    router = APIRouter()

    @router.post("/api/generate", status_code=202)
    async def start_generate(request: GenerateRequest) -> JobStartResponse:
        prompt = request.prompt.strip()
        if not prompt:
            raise HTTPException(
                status_code=400, detail="`prompt` must be a non-empty string"
            )
        if request.amend_rounds < 0:
            raise HTTPException(
                status_code=400, detail="`amendRounds` must be a non-negative integer"
            )

        job_id = str(uuid.uuid4())
        job = JobStatus(status="running", log=[])
        store.set(job_id, job)
        store.persist(job_id, job)

        asyncio.create_task(_run(job_id, prompt, request.amend_rounds, store))
        return JobStartResponse(job_id=job_id)

    @router.get("/api/generate/{job_id}")
    async def get_generate(job_id: str) -> JobStatus:
        job = store.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail=f"no job with id \"{job_id}\"")
        return job

    return router
