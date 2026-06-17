"""Tests for the Meshy asset provider."""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from meshy.cache import derive_key, write_index
from meshy.gen_params import param_signature
from pipeline import asset_provider
from scene.schema import PlannedObject


def _object() -> PlannedObject:
    return PlannedObject(
        id="chair-1",
        label="Chair",
        meshyPrompt="isolated wooden dining chair",
        approxSize=(0.5, 0.9, 0.5),
        position=(0.0, 0.45, 0.0),
        rotationYDeg=0.0,
    )


def _key(obj: PlannedObject) -> str:
    return derive_key(obj.meshy_prompt, "refine", param_signature("refine"))


def test_generate_cache_hit_returns_existing_glb_without_client(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    cache_dir = tmp_path / "meshy"
    obj = _object()
    key = _key(obj)
    directory = cache_dir / key
    directory.mkdir(parents=True)
    glb_path = directory / "refine-1.glb"
    glb_path.write_bytes(b"cached-glb")
    candidate = {
        "taskId": "refine-1",
        "prompt": obj.meshy_prompt,
        "mode": "refine",
        "key": key,
        "status": "SUCCEEDED",
        "savedAt": 123,
        "glb": str(glb_path),
        "bytes": len(b"cached-glb"),
    }
    write_index(
        cache_dir,
        {
            key: {
                "prompt": obj.meshy_prompt,
                "mode": "refine",
                "key": key,
                "winner": None,
                "candidates": [candidate],
            }
        },
    )
    events: list[dict] = []
    monkeypatch.setattr(asset_provider, "DEFAULT_CACHE_DIR", cache_dir)
    monkeypatch.setattr(asset_provider, "log_event", events.append)
    monkeypatch.setattr(
        asset_provider,
        "create_meshy_client",
        lambda _api_key: pytest.fail("cache hit constructed a Meshy client"),
    )

    result = asyncio.run(asset_provider.generate(obj))

    assert result == str(glb_path)
    assert events == [
        {"kind": "meshy.cache_hit", "objId": obj.id, "key": key, "glb": str(glb_path)}
    ]
    assert (directory / "meta.json").exists()


def test_generate_cache_miss_persists_glb_index_candidate_and_meta(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    cache_dir = tmp_path / "meshy"
    obj = _object()
    key = _key(obj)
    events: list[dict] = []
    calls: list[tuple] = []

    class FakeClient:
        async def submit_preview(self, prompt: str, params: dict) -> str:
            calls.append(("submit_preview", prompt, params))
            return "preview-1"

        async def submit_refine(self, preview_task_id: str, params: dict) -> str:
            calls.append(("submit_refine", preview_task_id, params))
            return "refine-1"

        async def wait_for_task(
            self, task_id: str, *, poll_interval_ms: int, timeout_ms: int
        ) -> SimpleNamespace:
            calls.append(("wait_for_task", task_id, poll_interval_ms, timeout_ms))
            return SimpleNamespace(
                id=task_id,
                status="SUCCEEDED",
                model_urls={"glb": "https://example.test/model.glb"},
            )

        async def download_glb(self, url: str) -> bytes:
            calls.append(("download_glb", url))
            return b"new-glb"

    monkeypatch.setattr(asset_provider, "DEFAULT_CACHE_DIR", cache_dir)
    monkeypatch.setattr(asset_provider, "log_event", events.append)
    monkeypatch.setattr(
        asset_provider,
        "load_config",
        lambda: SimpleNamespace(meshy_api_key="test-key"),
    )
    monkeypatch.setattr(asset_provider, "create_meshy_client", lambda _key: FakeClient())

    result = asyncio.run(asset_provider.generate(obj))

    glb_path = cache_dir / key / "refine-1.glb"
    assert result == str(glb_path)
    assert glb_path.read_bytes() == b"new-glb"
    candidate_path = cache_dir / key / "refine-1.json"
    candidate = json.loads(candidate_path.read_text(encoding="utf-8"))
    assert candidate["taskId"] == "refine-1"
    assert candidate["glb"] == str(glb_path)
    assert candidate["bytes"] == len(b"new-glb")
    index = json.loads((cache_dir / "index.json").read_text(encoding="utf-8"))
    assert index[key]["candidates"][0]["taskId"] == "refine-1"
    assert json.loads((cache_dir / key / "meta.json").read_text(encoding="utf-8"))[
        "normalizedPrompt"
    ] == "isolated wooden dining chair"
    assert [event["kind"] for event in events] == [
        "meshy.cache_miss",
        "meshy.preview_submit",
        "meshy.refine_submit",
        "meshy.done",
    ]
    assert calls[0] == ("submit_preview", obj.meshy_prompt, asset_provider.PREVIEW_PARAMS)
    assert calls[1] == (
        "wait_for_task",
        "preview-1",
        asset_provider.POLL_INTERVAL_MS,
        asset_provider.TIMEOUT_MS,
    )
