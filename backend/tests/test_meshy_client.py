"""Retry + timeout tests for the Meshy HTTP client.

No network is involved: ``httpx.AsyncClient`` is monkeypatched to a scripted fake
so the retry helper's explicit error-class dispatch is exercised deterministically.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from meshy import client as meshy_client


class _FakeResponse:
    def __init__(
        self,
        status_code: int = 200,
        payload: dict[str, Any] | None = None,
        text: str = "ok",
    ) -> None:
        self.status_code = status_code
        self._payload = payload if payload is not None else {}
        self.text = text
        self.content = text.encode()

    def json(self) -> dict[str, Any]:
        return self._payload


class _FakeClient:
    """Async-context-manager client whose get/post pull from a scripted queue."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        # timeout= and any other httpx.AsyncClient kwargs are ignored.
        pass

    async def __aenter__(self) -> "_FakeClient":
        return self

    async def __aexit__(self, *exc: Any) -> bool:
        return False


def _client_with_get(outcomes: list[Any]) -> tuple[type, dict[str, int]]:
    state = {"i": 0, "calls": 0}

    class _C(_FakeClient):
        async def get(
            self, url: str, headers: dict[str, str] | None = None
        ) -> _FakeResponse:
            state["calls"] += 1
            outcome = outcomes[state["i"]]
            state["i"] += 1
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

    return _C, state


def _client_with_post(outcomes: list[Any]) -> tuple[type, dict[str, int]]:
    state = {"i": 0, "calls": 0}

    class _C(_FakeClient):
        async def post(
            self,
            url: str,
            headers: dict[str, str] | None = None,
            json: Any = None,
        ) -> _FakeResponse:
            state["calls"] += 1
            outcome = outcomes[state["i"]]
            state["i"] += 1
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

    return _C, state


def _poll_payload() -> dict[str, Any]:
    return {
        "id": "t-1",
        "status": "SUCCEEDED",
        "progress": 100,
        "model_urls": {"glb": "https://example.test/model.glb"},
    }


@pytest.mark.asyncio
async def test_poll_task_retries_transient_transport_error_then_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Idempotent GET: a transient ReadTimeout is retried and then succeeds."""
    monkeypatch.setattr(meshy_client, "RETRY_BACKOFF_S", 0)
    fake_cls, state = _client_with_get(
        [
            httpx.ReadTimeout("transient read timeout"),
            _FakeResponse(200, payload=_poll_payload()),
        ]
    )
    monkeypatch.setattr(httpx, "AsyncClient", fake_cls)

    client = meshy_client.MeshyClient("msy_test")
    task = await client.poll_task("t-1")

    assert task.status == "SUCCEEDED"
    assert task.id == "t-1"
    assert state["calls"] == 2  # one failed attempt + one retry that succeeded


@pytest.mark.asyncio
async def test_submit_job_does_not_retry_on_read_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Non-idempotent submit: a read timeout may mean the request was received, so
    it must NOT be retried (would risk a duplicate paid generation)."""
    monkeypatch.setattr(meshy_client, "RETRY_BACKOFF_S", 0)
    fake_cls, state = _client_with_post([httpx.ReadTimeout("read timed out")])
    monkeypatch.setattr(httpx, "AsyncClient", fake_cls)

    client = meshy_client.MeshyClient("msy_test")
    with pytest.raises(httpx.ReadTimeout):
        await client._submit_job({"mode": "preview", "prompt": "a chair"})

    assert state["calls"] == 1


@pytest.mark.asyncio
async def test_submit_job_retries_connect_error_then_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Non-idempotent submit: a connect-phase failure (request never reached the
    server) is safe to retry."""
    monkeypatch.setattr(meshy_client, "RETRY_BACKOFF_S", 0)
    fake_cls, state = _client_with_post(
        [
            httpx.ConnectError("connection refused"),
            _FakeResponse(200, payload={"result": "task-9"}),
        ]
    )
    monkeypatch.setattr(httpx, "AsyncClient", fake_cls)

    client = meshy_client.MeshyClient("msy_test")
    task_id = await client._submit_job({"mode": "preview", "prompt": "a chair"})

    assert task_id == "task-9"
    assert state["calls"] == 2
