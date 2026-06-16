"""Single source of truth for the dream3d Meshy disk cache.

Mirrors src/meshy/cache.mjs. Every function here is zero-network and has zero
API-key dependency. Uses the exact same key scheme and file layout as the TS
implementation so existing ~/.cache/dream3d data remains compatible.
"""

import hashlib
import json
import os
from pathlib import Path
from typing import Any

DEFAULT_CACHE_DIR = Path.home() / ".cache" / "dream3d" / "meshy"

# Drift-guard anchor for the key FORMULA (not the live params).
CHECKPOINT_PROMPT = "a small wooden stool"
CHECKPOINT_PARAM_SIG = (
    '{"ai_model":"meshy-6","should_remesh":true,"target_polycount":300000,"topology":"triangle"}'
)
CHECKPOINT_KEY = "80b6483c5f285dba"


def normalize_prompt(prompt: str) -> str:
    """Normalize a prompt for stable cache keys."""
    return " ".join(prompt.strip().lower().split())


def derive_key(prompt: str, mode: str, param_sig: str) -> str:
    """Return sha256(normalizedPrompt + '::' + mode + '::' + paramSig), first 16 hex chars."""
    if not isinstance(param_sig, str) or len(param_sig) == 0:
        raise ValueError(
            f"derive_key requires a non-empty param_sig string (got {param_sig!r})"
        )
    normalized = normalize_prompt(prompt)
    digest = hashlib.sha256(
        f"{normalized}::{mode}::{param_sig}".encode("utf-8")
    ).hexdigest()
    return digest[:16]


def assert_key_scheme_is_stable() -> None:
    """Guard against silent drift in the key derivation formula."""
    got = derive_key(CHECKPOINT_PROMPT, "preview", CHECKPOINT_PARAM_SIG)
    if got != CHECKPOINT_KEY:
        raise RuntimeError(
            f"Cache key scheme drifted: key({CHECKPOINT_PROMPT!r}, 'preview', "
            f"<frozen sig>)={got}, expected {CHECKPOINT_KEY}. The key derivation "
            "formula changed; newly generated keys would not line up with "
            "previously cached entries."
        )


def serialize_cache(value: Any) -> str:
    """Serialize a value to 2-space JSON with no trailing newline."""
    return json.dumps(value, indent=2)


def _index_path(cache_dir: Path) -> Path:
    return cache_dir / "index.json"


def read_index(cache_dir: Path) -> dict[str, Any]:
    """Read the cache index, returning an empty dict if it does not exist."""
    path = _index_path(cache_dir)
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    return json.loads(raw)


def write_index(cache_dir: Path, index: dict[str, Any]) -> None:
    """Write the cache index to disk."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    _index_path(cache_dir).write_text(serialize_cache(index), encoding="utf-8")


def valid_candidates_on_disk(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep only candidates whose .glb file is still present on disk."""
    return [
        candidate
        for candidate in candidates
        if isinstance(candidate.get("glb"), str) and Path(candidate["glb"]).exists()
    ]


def select_candidate(entry: dict[str, Any]) -> dict[str, Any]:
    """Return the chosen candidate for an entry."""
    winner_id = entry.get("winner")
    if winner_id:
        for candidate in entry["candidates"]:
            if candidate.get("taskId") == winner_id:
                return candidate
        raise RuntimeError(
            f"cache entry {entry['key']} names winner {winner_id}, "
            "but no candidate has that taskId"
        )
    return entry["candidates"][0]


def ensure_dir_meta(
    cache_dir: Path,
    key: str,
    *,
    prompt: str,
    normalized_prompt: str,
    mode: str,
) -> None:
    """Write a human-readable meta.json marker into a cache key directory."""
    dir_path = cache_dir / key
    dir_path.mkdir(parents=True, exist_ok=True)
    meta_path = dir_path / "meta.json"
    if meta_path.exists():
        return
    meta_path.write_text(
        serialize_cache(
            {"key": key, "prompt": prompt, "normalizedPrompt": normalized_prompt, "mode": mode}
        ),
        encoding="utf-8",
    )


def rebuild_entry(cache_dir: Path, key: str) -> dict[str, Any]:
    """Wipe one cache entry and return the updated index."""
    import shutil

    shutil.rmtree(cache_dir / key, ignore_errors=True)
    index = read_index(cache_dir)
    index.pop(key, None)
    write_index(cache_dir, index)
    return index
