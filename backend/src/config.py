"""Configuration loader for the Python backend.

Reads config/local.json at the repo root and allows MESHY_API_KEY to override the
file value. Fails fast when neither source provides a key and one is requested.
"""

import json
import os
from pathlib import Path


class ConfigError(Exception):
    """Raised when required configuration is missing or invalid."""


class AppConfig:
    """Runtime configuration for the Python backend."""

    def __init__(self, meshy_api_key: str):
        if not isinstance(meshy_api_key, str) or meshy_api_key.strip() == "":
            raise ConfigError("meshyApiKey must be a non-empty string")
        self.meshy_api_key = meshy_api_key


def load_config() -> AppConfig:
    """Load configuration from config/local.json with MESHY_API_KEY env override.

    The file is optional when the environment variable is set. When neither source
    provides a non-empty key, raise ConfigError so the backend fails fast.
    """
    repo_root = Path(__file__).resolve().parents[2]
    config_path = repo_root / "config" / "local.json"

    file_value: str | None = None
    if config_path.exists():
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            raw = data.get("meshyApiKey")
            if isinstance(raw, str) and raw.strip():
                file_value = raw.strip()
        except (json.JSONDecodeError, OSError) as exc:
            raise ConfigError(f"failed to read {config_path}: {exc}") from exc

    env_value = os.environ.get("MESHY_API_KEY")
    if isinstance(env_value, str) and env_value.strip():
        return AppConfig(meshy_api_key=env_value.strip())

    if file_value is not None:
        return AppConfig(meshy_api_key=file_value)

    raise ConfigError(
        f"{config_path} not found or empty, and MESHY_API_KEY is not set — "
        "copy config/local.example.json to config/local.json and fill in your key"
    )
