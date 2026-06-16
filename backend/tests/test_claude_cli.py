"""Tests for llm/claude_cli.py auditing behavior."""

import json
from types import SimpleNamespace

import pytest

import llm.claude_cli as claude_cli


def test_run_claude_audits_success(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, object]] = []

    def fake_run(_cmd: list[str], **_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(
            returncode=0,
            stdout=json.dumps(
                {
                    "result": "done",
                    "session_id": "session-1",
                    "usage": {"input_tokens": 1},
                }
            ),
            stderr="",
        )

    monkeypatch.setattr(claude_cli, "new_id", lambda: "call-1")
    monkeypatch.setattr(claude_cli, "log_claude_call", calls.append)
    monkeypatch.setattr(claude_cli.subprocess, "run", fake_run)

    assert claude_cli.run_claude("make a scene", caller="planner") == "done"

    assert len(calls) == 1
    payload = calls[0]
    assert payload["callId"] == "call-1"
    assert payload["caller"] == "planner"
    assert payload["ok"] is True
    assert payload["result"] == "done"
    assert payload["session_id"] == "session-1"
    assert payload["usage"] == {"input_tokens": 1}


def test_run_claude_audits_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, object]] = []

    def fake_run(_cmd: list[str], **_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(returncode=2, stdout="", stderr="bad args")

    monkeypatch.setattr(claude_cli, "new_id", lambda: "call-2")
    monkeypatch.setattr(claude_cli, "log_claude_call", calls.append)
    monkeypatch.setattr(claude_cli.subprocess, "run", fake_run)

    with pytest.raises(RuntimeError, match="exited with code 2"):
        claude_cli.run_claude("make a scene", caller="planner")

    assert len(calls) == 1
    payload = calls[0]
    assert payload["callId"] == "call-2"
    assert payload["caller"] == "planner"
    assert payload["ok"] is False
    assert "exited with code 2" in str(payload["error"])
