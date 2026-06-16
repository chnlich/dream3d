"""Async Meshy client for text-to-3D preview and refine passes.

Mirrors src/meshy/client.ts. Uses httpx.AsyncClient with an Authorization
Bearer header. Fails loud on HTTP errors, terminal task states, and timeouts.
"""

import asyncio
import json
from typing import Any

import httpx

MESHY_BASE_URL = "https://api.meshy.ai"
TEXT_TO_3D_PATH = "/openapi/v2/text-to-3d"


def create_meshy_client(api_key: str) -> "MeshyClient":
    """Return a Meshy client closed over the given API key."""
    if not isinstance(api_key, str) or api_key.strip() == "":
        raise ValueError("Meshy API key must be a non-empty string")
    return MeshyClient(api_key)


class MeshyTask:
    """Snapshot of a Meshy generation task."""

    def __init__(
        self,
        *,
        id: str,
        status: str,
        progress: float,
        model_urls: dict[str, Any],
        task_error: dict[str, Any] | None = None,
    ):
        self.id = id
        self.status = status
        self.progress = progress
        self.model_urls = model_urls
        self.task_error = task_error


class MeshyClient:
    """Async HTTP client for the Meshy text-to-3D API."""

    def __init__(self, api_key: str):
        self._api_key = api_key
        self._auth_headers = {"Authorization": f"Bearer {api_key}"}

    async def submit_preview(
        self, prompt: str, preview_params: dict[str, Any]
    ) -> str:
        """Submit a preview-pass job and return the new task id."""
        return await self._submit_job(
            {
                "mode": "preview",
                "prompt": prompt,
                "target_formats": ["glb"],
                "should_remesh": preview_params["should_remesh"],
                "target_polycount": preview_params["target_polycount"],
                "topology": preview_params["topology"],
                "ai_model": preview_params["ai_model"],
            }
        )

    async def submit_refine(
        self, preview_task_id: str, refine_params: dict[str, Any]
    ) -> str:
        """Submit a refine-pass job on top of a completed preview task."""
        return await self._submit_job(
            {
                "mode": "refine",
                "preview_task_id": preview_task_id,
                "enable_pbr": refine_params["enable_pbr"],
                "remove_lighting": refine_params["remove_lighting"],
                "hd_texture": refine_params["hd_texture"],
                "ai_model": refine_params["ai_model"],
                "target_formats": ["glb"],
            }
        )

    async def _submit_job(self, body: dict[str, Any]) -> str:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{MESHY_BASE_URL}{TEXT_TO_3D_PATH}",
                headers={**self._auth_headers, "Content-Type": "application/json"},
                json=body,
            )
        if response.status_code >= 400:
            raise RuntimeError(
                f"Meshy submit failed: HTTP {response.status_code} {response.text}"
            )
        payload = response.json()
        task_id = payload.get("result")
        if not isinstance(task_id, str) or task_id.strip() == "":
            raise RuntimeError(
                f"Meshy submit returned no task id: {json.dumps(payload)}"
            )
        return task_id

    async def poll_task(self, task_id: str) -> MeshyTask:
        """Poll the current state of a task."""
        url = f"{MESHY_BASE_URL}{TEXT_TO_3D_PATH}/{task_id}"
        async with httpx.AsyncClient() as client:
            response = await client.get(url, headers=self._auth_headers)
        if response.status_code >= 400:
            raise RuntimeError(
                f"Meshy poll failed: HTTP {response.status_code} {response.text}"
            )
        payload = response.json()
        task_error = payload.get("task_error")
        return MeshyTask(
            id=payload["id"],
            status=payload["status"],
            progress=payload["progress"],
            model_urls={"glb": payload.get("model_urls", {}).get("glb")},
            task_error={"message": task_error["message"]} if task_error else None,
        )

    async def wait_for_task(
        self,
        task_id: str,
        *,
        poll_interval_ms: float,
        timeout_ms: float,
    ) -> MeshyTask:
        """Poll until the task succeeds; fail loud on terminal failure or timeout."""
        started_at = asyncio.get_event_loop().time()
        while True:
            task = await self.poll_task(task_id)
            if task.status == "SUCCEEDED":
                return task
            if task.status in ("FAILED", "CANCELED", "EXPIRED"):
                detail = f": {task.task_error['message']}" if task.task_error else ""
                raise RuntimeError(
                    f"Meshy task {task_id} ended with {task.status}{detail}"
                )
            if (asyncio.get_event_loop().time() - started_at) * 1000 >= timeout_ms:
                raise RuntimeError(
                    f"Meshy task {task_id} timed out after {timeout_ms} ms"
                )
            await asyncio.sleep(poll_interval_ms / 1000)

    async def download_glb(self, url: str) -> bytes:
        """Download a GLB from a presigned URL without Authorization header."""
        async with httpx.AsyncClient() as client:
            response = await client.get(url)
        if response.status_code >= 400:
            raise RuntimeError(
                f"Meshy GLB download failed: HTTP {response.status_code}"
            )
        if len(response.content) == 0:
            raise RuntimeError(
                f"Meshy GLB download returned an empty payload from {url}"
            )
        return response.content
