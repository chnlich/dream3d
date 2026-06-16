"""Central, single-source generation parameters for the Meshy text-to-3D pipeline.

Mirrors src/meshy/genParams.mjs. These literals are the only place the
preview/refine submit-body params live. Changing any param yields a new cache
key so stale bytes are never served.
"""

from typing import Any

PreviewParams = dict[str, Any]
RefineParams = dict[str, Any]

PREVIEW_PARAMS: PreviewParams = {
    "should_remesh": True,
    "target_polycount": 300000,
    "topology": "triangle",
    "ai_model": "meshy-6",
}

REFINE_PARAMS: RefineParams = {
    "enable_pbr": True,
    "remove_lighting": True,
    "hd_texture": False,
    "ai_model": "meshy-6",
}


def _sort_keys_deep(value: Any) -> Any:
    """Recursively sort object keys for stable canonical JSON."""
    if isinstance(value, list):
        return [_sort_keys_deep(item) for item in value]
    if isinstance(value, dict):
        return {key: _sort_keys_deep(value[key]) for key in sorted(value.keys())}
    return value


def canonical_json(value: Any) -> str:
    """Return canonical, key-sorted JSON of a value."""
    import json

    return json.dumps(_sort_keys_deep(value), separators=(",", ":"))


def param_signature(mode: str) -> str:
    """Return the output-affecting param signature for a mode.

    The refine signature includes the preview params it was built on, so
    changing a preview param invalidates cached refined assets too.
    """
    if mode == "preview":
        return canonical_json(PREVIEW_PARAMS)
    if mode == "refine":
        return canonical_json({"preview": PREVIEW_PARAMS, "refine": REFINE_PARAMS})
    raise ValueError(f'param_signature: unknown mode "{mode}" (expected "preview" or "refine")')
