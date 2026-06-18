"""Loaders for agent-facing system prompt prose (externalized to .md files)."""

from pathlib import Path


def load(name: str) -> str:
    path = Path(__file__).parent / name
    return path.read_text(encoding="utf-8").rstrip("\n")
