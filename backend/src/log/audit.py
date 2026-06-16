"""Best-effort audit logger for Dream3D generation runs.

EXCEPTION to the repo-wide fail-loud rule: this module must never raise. A lost
log line must not interrupt a possibly paid generation, so filesystem failures
are reported to stderr and otherwise ignored.
"""

import json
import os
import re
import sys
import uuid
from contextvars import ContextVar
from datetime import datetime, timezone
from pathlib import Path
from types import TracebackType
from typing import Any

from scene.schema import GenerateResponse

UNASSIGNED_RUN = "_unassigned"

_run_id_var: ContextVar[str] = ContextVar(
    "dream3d_audit_run_id", default=UNASSIGNED_RUN
)


def _log_root() -> Path:
    log_dir = os.environ.get("DREAM3D_LOG_DIR")
    if log_dir is not None:
        return Path(log_dir)
    return Path.home() / ".cache" / "dream3d" / "uuid"


def new_id() -> str:
    return str(uuid.uuid4())


class _RunContext:
    def __init__(self, run_id: str) -> None:
        self.run_id = run_id
        self._token: Any | None = None

    def __enter__(self) -> "_RunContext":
        self._token = _run_id_var.set(self.run_id)
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> bool:
        _run_id_var.reset(self._token)
        return False

    async def __aenter__(self) -> "_RunContext":
        self._token = _run_id_var.set(self.run_id)
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> bool:
        _run_id_var.reset(self._token)
        return False


def with_run(run_id: str) -> _RunContext:
    return _RunContext(run_id)


def current_run_id() -> str:
    return _run_id_var.get()


def _iso_utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _report_failure(message: str, exc: BaseException) -> None:
    try:
        print(f"[dream3d-audit] {message}: {exc}", file=sys.stderr)
    except Exception:  # noqa: BLE001 - audit logging is best-effort.
        pass


def log_event(event: dict[str, Any]) -> None:
    run_id = current_run_id()
    try:
        directory = _log_root() / run_id
        directory.mkdir(parents=True, exist_ok=True)
        line = json.dumps({"ts": _iso_utc_now(), "runId": run_id, **event})
        with (directory / "events.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(f"{line}\n")
    except Exception as exc:  # noqa: BLE001 - audit logging is best-effort.
        _report_failure("log write failed", exc)


def log_claude_call(payload: dict[str, Any]) -> None:
    run_id = current_run_id()
    try:
        caller = str(payload.get("caller"))
        call_id = str(payload.get("callId"))
        directory = _log_root() / run_id / "llm"
        directory.mkdir(parents=True, exist_ok=True)
        (directory / f"{caller}-{call_id}.json").write_text(
            json.dumps(payload, indent=2),
            encoding="utf-8",
        )
    except Exception as exc:  # noqa: BLE001 - audit logging is best-effort.
        _report_failure("log write failed", exc)

    try:
        summary: dict[str, Any] = {
            "kind": "llm.call",
            "callId": payload.get("callId"),
            "caller": payload.get("caller"),
            "model": payload.get("model"),
            "ok": payload.get("ok"),
            "durationMs": payload.get("durationMs"),
        }
        if "session_id" in payload:
            summary["sessionId"] = payload["session_id"]
        if "total_cost_usd" in payload:
            summary["costUsd"] = payload["total_cost_usd"]
        if "usage" in payload:
            summary["usage"] = payload["usage"]
        log_event(summary)
    except Exception as exc:  # noqa: BLE001 - audit logging is best-effort.
        _report_failure("log write failed", exc)


def _result_to_dict(result: GenerateResponse | dict[str, Any]) -> dict[str, Any]:
    if isinstance(result, GenerateResponse):
        return result.model_dump(by_alias=True)
    if isinstance(result, dict):
        return result
    raise TypeError(f"mirror_run_assets expected GenerateResponse or dict, got {type(result).__name__}")


def mirror_run_assets(result: GenerateResponse | dict[str, Any]) -> None:
    try:
        directory = _log_root() / current_run_id() / "assets"
        directory.mkdir(parents=True, exist_ok=True)
        seen: set[str] = set()
        response = _result_to_dict(result)
        for pass_ in response["passes"]:
            for obj in pass_["sceneState"]["objects"]:
                src = obj.get("glbUrl")
                if not src or src in seen:
                    continue
                seen.add(src)
                if src.startswith("/assets/") or re.match(r"^https?://", src, re.IGNORECASE):
                    continue
                if not Path(src).exists():
                    continue
                safe_id = re.sub(r"[^a-zA-Z0-9_-]", "_", obj["id"])
                (directory / f"{safe_id}.glb").symlink_to(src)
    except Exception as exc:  # noqa: BLE001 - audit logging is best-effort.
        _report_failure("mirror assets failed", exc)
