"""Tests for pipeline caches and audit logging."""

import asyncio
import json
from pathlib import Path

import pytest

from log.audit import UNASSIGNED_RUN, current_run_id, log_event, with_run
from pipeline.disk_cache import create_disk_cache
from pipeline.plan_cache import derive_plan_key, get_or_create_plan
from pipeline.response_cache import (
    _validate_response,
    derive_response_key,
    read_cached_response,
    write_cached_response,
)
from scene.schema import (
    GenerateResponse,
    Pass,
    PlannedObject,
    Room,
    SceneObject,
    ScenePlan,
    SceneState,
    Transform,
)


def _plan() -> ScenePlan:
    return ScenePlan(
        prompt="a small wooden stool",
        room=Room(width=4.0, depth=4.0, height=3.0),
        objects=[
            PlannedObject(
                id="stool",
                label="stool",
                meshy_prompt="a small wooden stool",
                approx_size=(1.0, 1.0, 1.0),
                position=(0.0, 0.0, 0.0),
                rotation_y_deg=0.0,
            )
        ],
    )


def _response(glb_url: str | None = None) -> GenerateResponse:
    obj = SceneObject(
        id="stool",
        label="stool",
        meshy_prompt="a small wooden stool",
        approx_size=(1.0, 1.0, 1.0),
        transform=Transform(position=(0.0, 0.5, 0.0), rotation_y_deg=0.0, scale=1.0),
        glb_url=glb_url,
        status="ready",
    )
    return GenerateResponse(
        passes=[
            Pass(
                scene_state=SceneState(
                    room=Room(width=4.0, depth=4.0, height=3.0),
                    objects=[obj],
                    pass_=0,
                )
            )
        ]
    )


def test_disk_cache_round_trip(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    cache = create_disk_cache(
        dir_name="round-trip", label="thing", value_key="thing", version=1
    )

    key = cache.derive_key(["alpha", "beta"])
    cache.write(key, {"prompt": "alpha"}, {"answer": 42})

    assert cache.read(key) == {"answer": 42}
    path = tmp_path / ".cache" / "dream3d" / "round-trip" / f"{key}.json"
    text = path.read_text(encoding="utf-8")
    assert text.endswith("}")
    assert not text.endswith("\n")
    assert json.loads(text)["savedAt"] > 0


def test_disk_cache_clean_miss(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    cache = create_disk_cache(
        dir_name="missing", label="thing", value_key="thing", version=1
    )

    assert cache.read("does-not-exist") is None


def test_disk_cache_stale_version_returns_none(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    cache = create_disk_cache(
        dir_name="stale", label="thing", value_key="thing", version=1
    )
    directory = tmp_path / ".cache" / "dream3d" / "stale"
    directory.mkdir(parents=True)
    (directory / "abc.json").write_text(
        json.dumps({"version": 0, "key": "abc", "thing": {"old": True}}),
        encoding="utf-8",
    )

    assert cache.read("abc") is None


def test_disk_cache_corrupt_json_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    cache = create_disk_cache(
        dir_name="corrupt", label="thing", value_key="thing", version=1
    )
    directory = tmp_path / ".cache" / "dream3d" / "corrupt"
    directory.mkdir(parents=True)
    (directory / "abc.json").write_text("{", encoding="utf-8")

    with pytest.raises(RuntimeError, match="JSON parse failed"):
        cache.read("abc")


def test_disk_cache_validator_false_returns_none(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    cache = create_disk_cache(
        dir_name="validator-false",
        label="thing",
        value_key="thing",
        version=1,
        validate=lambda _value, _path: False,
    )
    cache.write("abc", {}, {"answer": 42})

    assert cache.read("abc") is None


def test_disk_cache_validator_raise_propagates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))

    def validate(_value: object, _path: str) -> bool:
        raise RuntimeError("bad value")

    cache = create_disk_cache(
        dir_name="validator-raise",
        label="thing",
        value_key="thing",
        version=1,
        validate=validate,
    )
    cache.write("abc", {}, {"answer": 42})

    with pytest.raises(RuntimeError, match="bad value"):
        cache.read("abc")


def test_key_drift_guards() -> None:
    assert derive_plan_key("a small wooden stool") == "73e6ea052b6f0aa1"
    assert derive_response_key("a small wooden stool", 1) == "3faf359d5b38617e"


def test_response_validator_local_missing_glb_returns_false(tmp_path: Path) -> None:
    value = {
        "passes": [
            {"sceneState": {"objects": [{"id": "a", "glbUrl": str(tmp_path / "missing.glb")}]}}
        ]
    }

    assert _validate_response(value, "cache.json") is False


def test_response_validator_ignores_remote_and_assets_paths() -> None:
    value = {
        "passes": [
            {
                "sceneState": {
                    "objects": [
                        {"id": "a", "glbUrl": "http://example.test/a.glb"},
                        {"id": "b", "glbUrl": "https://example.test/b.glb"},
                        {"id": "c", "glbUrl": "/assets/c.glb"},
                    ]
                }
            }
        ]
    }

    assert _validate_response(value, "cache.json") is True


def test_response_cache_round_trip(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    key = derive_response_key("a small wooden stool", 1)

    write_cached_response(
        key,
        prompt="a small wooden stool",
        amend_rounds=1,
        response=_response("/assets/stool.glb"),
    )

    cached = read_cached_response(key)
    assert cached is not None
    assert cached.passes[0].scene_state.objects[0].glb_url == "/assets/stool.glb"
    path = tmp_path / ".cache" / "dream3d" / "responses" / f"{key}.json"
    raw = json.loads(path.read_text(encoding="utf-8"))
    assert raw["amendRounds"] == 1
    assert raw["response"]["passes"][0]["sceneState"]["objects"][0]["glbUrl"] == "/assets/stool.glb"


def test_plan_cache_get_or_create_hits_and_can_bypass(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("DREAM3D_PLAN_CACHE", raising=False)
    calls = 0

    async def make_plan() -> ScenePlan:
        nonlocal calls
        calls += 1
        return _plan()

    first = asyncio.run(get_or_create_plan("a small wooden stool", make_plan))
    second = asyncio.run(get_or_create_plan("a small wooden stool", make_plan))

    assert first == second
    assert calls == 1
    assert "[dream3d] plan cache HIT 73e6ea052b6f0aa1" in capsys.readouterr().out

    monkeypatch.setenv("DREAM3D_PLAN_CACHE", "0")
    asyncio.run(get_or_create_plan("a small wooden stool", make_plan))
    assert calls == 2


def test_with_run_binds_and_propagates_across_await() -> None:
    async def check() -> None:
        assert current_run_id() == UNASSIGNED_RUN
        with with_run("run-1"):
            assert current_run_id() == "run-1"
            await asyncio.sleep(0)
            assert current_run_id() == "run-1"
        assert current_run_id() == UNASSIGNED_RUN

    asyncio.run(check())


def test_log_event_writes_parseable_jsonl(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DREAM3D_LOG_DIR", str(tmp_path))

    with with_run("run-2"):
        log_event({"kind": "unit.test", "ok": True})

    path = tmp_path / "run-2" / "events.jsonl"
    line = path.read_text(encoding="utf-8").strip()
    event = json.loads(line)
    assert event["runId"] == "run-2"
    assert event["kind"] == "unit.test"
    assert event["ok"] is True
    assert event["ts"].endswith("Z")


def test_log_event_write_failure_does_not_raise(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    bad_root = tmp_path / "not-a-dir"
    bad_root.write_text("not a directory", encoding="utf-8")
    monkeypatch.setenv("DREAM3D_LOG_DIR", str(bad_root))

    log_event({"kind": "unit.test"})

    assert "[dream3d-audit] log write failed:" in capsys.readouterr().err
