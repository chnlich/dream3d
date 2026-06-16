"""Response-level cache for Dream3D /api/generate results."""

from pathlib import Path
from typing import Any

from meshy.cache import normalize_prompt
from pipeline.disk_cache import create_disk_cache
from scene.schema import GenerateResponse

RESPONSE_CACHE_VERSION = 1


def _validate_response(value: Any, path: str) -> bool:
    if not isinstance(value, dict) or not isinstance(value.get("passes"), list):
        raise RuntimeError(
            f'Corrupt response cache {path}: "response" is not an object with a "passes" array'
        )

    for pass_ in value["passes"]:
        for obj in pass_["sceneState"]["objects"]:
            glb_url = obj.get("glbUrl")
            if not isinstance(glb_url, str) or len(glb_url) == 0:
                continue
            if (
                glb_url.startswith("http://")
                or glb_url.startswith("https://")
                or glb_url.startswith("/assets/")
            ):
                continue
            if not Path(glb_url).exists():
                return False
    return True


cache = create_disk_cache(
    dir_name="responses",
    label="response",
    value_key="response",
    version=RESPONSE_CACHE_VERSION,
    validate=_validate_response,
)


def derive_response_key(prompt: str, amend_rounds: int) -> str:
    return cache.derive_key([str(amend_rounds), normalize_prompt(prompt)])


def read_cached_response(key: str) -> GenerateResponse | None:
    value = cache.read(key)
    if value is None:
        return None
    return GenerateResponse.model_validate(value)


def write_cached_response(
    key: str,
    *,
    prompt: str,
    amend_rounds: int,
    response: GenerateResponse,
) -> None:
    cache.write(
        key,
        {
            "prompt": prompt,
            "normalizedPrompt": normalize_prompt(prompt),
            "amendRounds": amend_rounds,
        },
        response.model_dump(by_alias=True),
    )
