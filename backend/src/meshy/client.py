"""Async Meshy client for text-to-3D preview and refine passes.

Mirrors src/meshy/client.ts. Uses httpx.AsyncClient with an Authorization
Bearer header. Fails loud on HTTP errors, terminal task states, and timeouts.
"""

import asyncio
import json
from collections.abc import Awaitable, Callable
from typing import Any, Literal
from urllib.parse import quote

import httpx

MESHY_BASE_URL = "https://api.meshy.ai"
TEXT_TO_3D_PATH = "/openapi/v2/text-to-3d"

# Per-request timeout: 60s total, 10s to establish the TCP connection.
HTTP_TIMEOUT = httpx.Timeout(60.0, connect=10.0)
# Bounded retry for transient failures: connect errors / rate limiting / 5xx.
MAX_ATTEMPTS = 3
RETRY_BACKOFF_S = 1.5

_RetryPolicy = Literal["submit", "idempotent"]


async def _retry_http(
    send: Callable[[], Awaitable[httpx.Response]],
    *,
    policy: _RetryPolicy,
) -> httpx.Response:
    """Run an HTTP request with bounded retry on transient failures.

    Dispatch is explicit by error class:
      * Connect-phase failures (ConnectError / ConnectTimeout -- the request never
        reached the server) are retried for BOTH policies.
      * Other TransportError (e.g. ReadTimeout / WriteTimeout -- the request may have
        reached the server) is retried only for idempotent GETs; for `submit` it is
        raised immediately, since re-POSTing a request that may already have been
        received would create a DUPLICATE PAID generation (Meshy has no idempotency key).
      * HTTP 429 is retried for both; 5xx is retried only for idempotent GETs.

    ConnectError / ConnectTimeout are subclasses of TransportError, so the connect
    clause is ordered first. After MAX_ATTEMPTS the failure is re-raised loudly.
    """
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            response = await send()
        except (httpx.ConnectError, httpx.ConnectTimeout):
            if attempt >= MAX_ATTEMPTS:
                raise
            await asyncio.sleep(RETRY_BACKOFF_S * attempt)
            continue
        except httpx.TransportError:
            if policy == "submit" or attempt >= MAX_ATTEMPTS:
                raise
            await asyncio.sleep(RETRY_BACKOFF_S * attempt)
            continue
        status = response.status_code
        retry_status = status == 429 or (
            policy == "idempotent" and status >= 500
        )
        if retry_status and attempt < MAX_ATTEMPTS:
            await asyncio.sleep(RETRY_BACKOFF_S * attempt)
            continue
        return response
    raise RuntimeError("_retry_http exhausted without returning a response")


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
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            response = await _retry_http(
                lambda: client.post(
                    f"{MESHY_BASE_URL}{TEXT_TO_3D_PATH}",
                    headers={
                        **self._auth_headers,
                        "Content-Type": "application/json",
                    },
                    json=body,
                ),
                policy="submit",
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
        url = f"{MESHY_BASE_URL}{TEXT_TO_3D_PATH}/{quote(task_id, safe='')}"
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            response = await _retry_http(
                lambda: client.get(url, headers=self._auth_headers),
                policy="idempotent",
            )
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
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            response = await _retry_http(
                lambda: client.get(url),
                policy="idempotent",
            )
        if response.status_code >= 400:
            raise RuntimeError(
                f"Meshy GLB download failed: HTTP {response.status_code}"
            )
        if len(response.content) == 0:
            raise RuntimeError(
                f"Meshy GLB download returned an empty payload from {url}"
            )
        return response.content
