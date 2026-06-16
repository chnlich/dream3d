"""Persistent in-memory job store.

Jobs are read from and written to ~/.cache/dream3d/uuid/<jobId>/status.json.
Writes are atomic (temp file + rename) and never block the request path on
failure; instead they log a warning.
"""

import json
import logging
import os
import tempfile
from pathlib import Path

from scene.schema import JobStatus

logger = logging.getLogger(__name__)


def _status_dir() -> Path:
    return Path.home() / ".cache" / "dream3d" / "uuid"


def _status_path(job_id: str) -> Path:
    return _status_dir() / job_id / "status.json"


class JobStore:
    """In-memory job cache backed by atomic writes to the dream3d uuid directory."""

    def __init__(self) -> None:
        self._jobs: dict[str, JobStatus] = {}

    def get(self, job_id: str) -> JobStatus | None:
        return self._jobs.get(job_id)

    def set(self, job_id: str, job: JobStatus) -> None:
        self._jobs[job_id] = job

    def persist(self, job_id: str, job: JobStatus) -> None:
        """Persist job to disk atomically; log a warning on failure but do not raise."""
        path = _status_path(job_id)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            data = job.model_dump(by_alias=True)
            fd, tmp = tempfile.mkstemp(dir=path.parent, prefix="status-")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=2)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp, path)
            except Exception:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed to persist job %s: %s", job_id, exc)

    def load_historical_jobs(self) -> dict[str, JobStatus]:
        """Scan the uuid directory and load historical jobs.

        Any job that was still 'running' is marked as 'error' because the backend
        restarted while it was in flight.
        """
        status_dir = _status_dir()
        loaded: dict[str, JobStatus] = {}
        if not status_dir.exists():
            return loaded

        for entry in status_dir.iterdir():
            if not entry.is_dir():
                continue
            job_id = entry.name
            path = _status_path(job_id)
            if not path.exists():
                continue
            try:
                with open(path, "r", encoding="utf-8") as f:
                    raw = json.load(f)
                job = JobStatus.model_validate(raw)
                if job.status == "running":
                    job.status = "error"
                    job.error = "backend restarted while job was running"
                    self.persist(job_id, job)
                loaded[job_id] = job
            except Exception as exc:  # noqa: BLE001
                logger.warning("Failed to load historical job %s: %s", job_id, exc)

        self._jobs = loaded
        return loaded
