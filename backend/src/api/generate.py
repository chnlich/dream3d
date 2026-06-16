"""Generate routes and mock pipeline for the Python backend.

POST /api/generate starts a background mock pipeline that sleeps and emits
progress log entries matching the format expected by src/studioMain.ts.
GET /api/generate/<jobId> returns the current JobStatus.
"""

import asyncio
import time
import uuid

from fastapi import APIRouter, HTTPException

from scene.schema import (
    GenerateRequest,
    GenerateResponse,
    JobStartResponse,
    JobStatus,
    LogLine,
    Pass,
    Room,
    SceneObject,
    SceneState,
    Transform,
)
from server.job_store import JobStore

router = APIRouter()

# Number of placeholder objects produced by the mock planner.
MOCK_OBJECT_COUNT = 3


def _now_ms() -> int:
    return int(time.time() * 1000)


def _append_log(job: JobStatus, text: str) -> None:
    job.log.append(LogLine(ts=_now_ms(), text=text))


def _mock_object_label(index: int, prompt: str) -> str:
    labels = ["hero object", "support object", "accent object"]
    if index < len(labels):
        return labels[index]
    return f"object {index + 1}"


def _build_mock_result(prompt: str, amend_rounds: int) -> GenerateResponse:
    """Build a minimal GenerateResponse with one placeholder object per pass."""
    room = Room(width=8.0, depth=6.0, height=3.0)
    passes: list[Pass] = []
    for p in range(amend_rounds + 1):
        obj = SceneObject(
            id=f"obj-{p + 1}",
            label=prompt,
            meshy_prompt=prompt,
            approx_size=(1.0, 1.0, 1.0),
            transform=Transform(position=(0.0, 0.5, 0.0), rotation_y_deg=0.0, scale=1.0),
            status="pending",
        )
        passes.append(
            Pass(scene_state=SceneState(room=room, objects=[obj], pass_=p))
        )
    return GenerateResponse(passes=passes)


async def _mock_pipeline(
    job_id: str, prompt: str, amend_rounds: int, store: JobStore
) -> None:
    """Simulate the generation pipeline with sleeps and progress log entries."""
    job = store.get(job_id)
    if job is None:
        raise RuntimeError(f"job {job_id} disappeared from store")

    def log(text: str) -> None:
        _append_log(job, text)
        store.persist(job_id, job)

    try:
        # Step 1: plan
        log("Planning scene…")
        await asyncio.sleep(2.0)

        log(f"Plan ready — {MOCK_OBJECT_COUNT} object(s)")
        await asyncio.sleep(1.0)

        # Step 2: assets
        for i in range(MOCK_OBJECT_COUNT):
            label = _mock_object_label(i, prompt)
            log(f"Starting asset {i + 1}/{MOCK_OBJECT_COUNT}: {label}")
            await asyncio.sleep(0.5)
            log(f"Generating asset {i + 1}/{MOCK_OBJECT_COUNT}: {label}")
            await asyncio.sleep(1.5)

        # Step 3: layout
        log("Arranging layout…")
        await asyncio.sleep(1.0)

        # Step 4: amend loop
        for r in range(1, amend_rounds + 1):
            log(f"Amend {r}: rendering")
            await asyncio.sleep(1.5)
            log(f"Amend {r}: 2 issue(s) found")
            await asyncio.sleep(1.5)
            log(f"Amend {r}: applied fixes")
            await asyncio.sleep(0.5)

        log(f"Done — {amend_rounds + 1} pass(es)")
        job.status = "done"
        job.result = _build_mock_result(prompt, amend_rounds)
    except Exception as exc:  # noqa: BLE001
        job.status = "error"
        job.error = str(exc)
        _append_log(job, f"Error: {exc}")
    finally:
        store.persist(job_id, job)


def create_generate_router(store: JobStore) -> APIRouter:
    """Factory that returns the generate router bound to a JobStore instance."""

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

        # Start the mock pipeline as a background task.
        asyncio.create_task(
            _mock_pipeline(job_id, prompt, request.amend_rounds, store)
        )
        return JobStartResponse(job_id=job_id)

    @router.get("/api/generate/{job_id}")
    async def get_generate(job_id: str) -> JobStatus:
        job = store.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail=f"no job with id \"{job_id}\"")
        return job

    return router
