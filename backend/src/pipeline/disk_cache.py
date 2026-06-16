"""Generic on-disk JSON cache for Dream3D pipeline artifacts.

Mirrors src/pipeline/diskCache.ts. Cache files live under
~/.cache/dream3d/<dir_name>/<key>.json and use a versioned envelope. Reads fail
loud on corruption and return None only for expected misses or staleness.
"""

import hashlib
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


ValidateFn = Callable[[Any, str], bool]


@dataclass(frozen=True)
class DiskCache:
    dir_name: str
    label: str
    value_key: str
    version: int
    validate: ValidateFn | None = None

    def _dir(self) -> Path:
        return Path.home() / ".cache" / "dream3d" / self.dir_name

    def _path_for(self, key: str) -> Path:
        return self._dir() / f"{key}.json"

    def derive_key(self, parts: list[str]) -> str:
        digest = hashlib.sha256(
            "::".join([str(self.version), *parts]).encode("utf-8")
        ).hexdigest()
        return digest[:16]

    def read(self, key: str) -> Any | None:
        path = self._path_for(key)
        try:
            raw = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return None

        try:
            envelope = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                f"Corrupt {self.label} cache {path}: JSON parse failed ({exc})"
            ) from exc

        if not isinstance(envelope, dict):
            raise RuntimeError(
                f"Corrupt {self.label} cache {path}: envelope is not a JSON object"
            )

        envelope_version = envelope.get("version")
        if isinstance(envelope_version, bool) or not isinstance(
            envelope_version, (int, float)
        ):
            raise RuntimeError(
                f'Corrupt {self.label} cache {path}: missing numeric "version"'
            )

        value = envelope[self.value_key]
        if self.validate is not None and not self.validate(value, str(path)):
            return None

        if envelope_version != self.version:
            return None

        return value

    def write(self, key: str, provenance: dict[str, Any], value: Any) -> None:
        directory = self._dir()
        directory.mkdir(parents=True, exist_ok=True)
        envelope = {
            "version": self.version,
            "key": key,
            **provenance,
            "savedAt": int(time.time()),
            self.value_key: value,
        }
        final_path = self._path_for(key)
        tmp_path = Path(f"{final_path}.tmp")
        tmp_path.write_text(json.dumps(envelope, indent=2), encoding="utf-8")
        os.replace(tmp_path, final_path)


def create_disk_cache(
    *,
    dir_name: str,
    label: str,
    value_key: str,
    version: int,
    validate: ValidateFn | None = None,
) -> DiskCache:
    return DiskCache(
        dir_name=dir_name,
        label=label,
        value_key=value_key,
        version=version,
        validate=validate,
    )
