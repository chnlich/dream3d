"""Claude vision critic for rendered Dream3D scenes."""

import base64
import json
import math
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any

from llm.claude_cli import run_claude
from pipeline.prompts import load
from scene.schema import Fix, ReviewIssue, SceneState, Vec3

ISSUE_KINDS = (
    "overlap",
    "floating",
    "wrong_facing",
    "too_big",
    "too_small",
    "out_of_bounds",
)
SEVERITIES = ("low", "medium", "high")
FIX_OPS = ("move", "rotate", "resize")

EXT_BY_MEDIA = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
}

SYSTEM_PROMPT = load("vision_critic_system.md")

VEC3_SCHEMA = {
    "type": "array",
    "items": {"type": "number"},
    "minItems": 3,
    "maxItems": 3,
}

REVIEW_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["issues"],
    "properties": {
        "issues": {
            "type": "array",
            "description": "zero or more concrete issues; empty when the scene looks correct",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["objectId", "kind", "severity", "description", "fix"],
                "properties": {
                    "objectId": {
                        "type": "string",
                        "description": "id of the offending object; must exist in the layout",
                    },
                    "kind": {"type": "string", "enum": ISSUE_KINDS},
                    "severity": {"type": "string", "enum": SEVERITIES},
                    "description": {
                        "type": "string",
                        "description": "one concrete sentence describing the visible problem",
                    },
                    "fix": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["op"],
                        "properties": {
                            "op": {"type": "string", "enum": FIX_OPS},
                            "delta": {
                                **VEC3_SCHEMA,
                                "description": "move op: meters added to position [dx, dy, dz]",
                            },
                            "rotationYDeg": {
                                "type": "number",
                                "description": "rotate op: degrees added to current yaw",
                            },
                            "scaleFactor": {
                                "type": "number",
                                "description": "resize op: multiplier on current scale (>1 bigger)",
                            },
                        },
                    },
                },
            },
        },
    },
}

DATA_URL_RE = re.compile(r"^data:(image/(?:png|jpe?g|gif|webp));base64,(.+)$", re.S)


async def review(scene: SceneState, views: list[dict[str, str]]) -> list[ReviewIssue]:
    if len(views) == 0:
        raise ValueError("claudeVisionCritic: review requires at least one rendered view")
    known_ids = {obj.id for obj in scene.objects}

    directory = Path(tempfile.mkdtemp(prefix="dream3d-critic-"))
    try:
        image_paths: list[str] = []
        for view in views:
            name = view["name"]
            image = _parse_data_url(view["dataUrl"], name)
            image_path = directory / f"{name}.{EXT_BY_MEDIA[image['media_type']]}"
            image_path.write_bytes(base64.b64decode(image["data"], validate=True))
            image_paths.append(str(image_path))

        prompt = "\n".join(
            [
                SYSTEM_PROMPT,
                "",
                f"The {len(views)} image(s) are labeled camera angles of the SAME scene ({', '.join(view['name'] for view in views)}) —",
                "the same objects seen from different positions, not different scenes. Report each object AT MOST ONCE",
                "across all angles, citing the angle where the problem is clearest.",
                "",
                f"Layout JSON:\n{layout_summary(scene)}",
                "",
                "Respond with ONLY the JSON object — no prose, no markdown code fences. It must match this schema:",
                json.dumps(REVIEW_SCHEMA, indent=2),
            ]
        )
        text = run_claude(prompt, image_paths=image_paths, caller="vision-critic")
    finally:
        shutil.rmtree(directory)

    result = _as_record(_parse_json(text), "review result")
    issues = result.get("issues")
    if not isinstance(issues, list):
        raise ValueError(
            f"claudeVisionCritic: expected issues[] array, got {_describe(issues)}"
        )

    parsed: list[ReviewIssue] = []
    for i, raw in enumerate(issues):
        issue = _as_record(raw, f"issues[{i}]")
        object_id = _as_non_empty_string(issue.get("objectId"), f"issues[{i}].objectId")
        if object_id not in known_ids:
            raise ValueError(
                f'claudeVisionCritic: issues[{i}].objectId "{object_id}" is not in the scene'
            )
        parsed.append(
            ReviewIssue(
                objectId=object_id,
                kind=_as_enum(issue.get("kind"), ISSUE_KINDS, f"issues[{i}].kind"),
                severity=_as_enum(
                    issue.get("severity"), SEVERITIES, f"issues[{i}].severity"
                ),
                description=_as_non_empty_string(
                    issue.get("description"), f"issues[{i}].description"
                ),
                fix=_parse_fix(issue.get("fix"), f"issues[{i}].fix"),
                source="vision",
            )
        )
    return parsed


def layout_summary(scene: SceneState) -> str:
    return json.dumps(
        {
            "room": scene.room.model_dump(),
            "pass": scene.pass_,
            "objects": [
                {
                    "id": obj.id,
                    "label": obj.label,
                    "approxSize": obj.approx_size,
                    "position": obj.transform.position,
                    "rotationYDeg": obj.transform.rotation_y_deg,
                    "scale": obj.transform.scale,
                    "status": obj.status,
                }
                for obj in scene.objects
            ],
        },
        indent=2,
    )


def _parse_data_url(data_url: str, view_name: str) -> dict[str, str]:
    match = DATA_URL_RE.match(data_url.strip())
    if not match:
        raise ValueError(
            f'claudeVisionCritic: view "{view_name}" dataUrl must be a base64-encoded image data URL'
        )
    declared = match.group(1)
    media_type = "image/jpeg" if declared == "image/jpg" else declared
    return {"media_type": media_type, "data": match.group(2)}


def _parse_json(text: str) -> Any:
    body = text.strip()
    fence = re.search(r"```(?:json)?\s*\n?([\s\S]*?)```", body)
    if fence:
        body = fence.group(1).strip()
    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        salvaged = _slice_outermost_json(body)
        if salvaged is not None:
            try:
                return json.loads(salvaged)
            except json.JSONDecodeError as salvage_exc:
                exc.add_note(f"salvaged JSON parse also failed: {salvage_exc}")
        raise ValueError(
            f"claudeVisionCritic: model output was not valid JSON: {body[:1000]}"
        ) from exc


def _slice_outermost_json(body: str) -> str | None:
    open_brace = body.find("{")
    if open_brace != -1:
        close_brace = body.rfind("}")
        if close_brace > open_brace:
            return body[open_brace : close_brace + 1]
        return None
    open_bracket = body.find("[")
    if open_bracket != -1:
        close_bracket = body.rfind("]")
        if close_bracket > open_bracket:
            return body[open_bracket : close_bracket + 1]
    return None


def _parse_fix(value: Any, ctx: str) -> Fix:
    raw = _as_record(value, ctx)
    op = raw.get("op")
    if op == "move":
        return Fix(op="move", delta=_as_vec3(raw.get("delta"), f"{ctx}.delta"))
    if op == "rotate":
        return Fix(
            op="rotate",
            rotationYDeg=_as_number(raw.get("rotationYDeg"), f"{ctx}.rotationYDeg"),
        )
    if op == "resize":
        return Fix(
            op="resize",
            scaleFactor=_as_number(raw.get("scaleFactor"), f"{ctx}.scaleFactor"),
        )
    raise ValueError(
        f"claudeVisionCritic: expected one of [{', '.join(FIX_OPS)}] at {ctx}.op, got {_describe(op)}"
    )


def _as_enum(value: Any, allowed: tuple[str, ...], ctx: str) -> str:
    if not isinstance(value, str) or value not in allowed:
        raise ValueError(
            f"claudeVisionCritic: expected one of [{', '.join(allowed)}] at {ctx}, got {_describe(value)}"
        )
    return value


def _as_record(value: Any, ctx: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(
            f"claudeVisionCritic: expected an object at {ctx}, got {_describe(value)}"
        )
    return value


def _as_number(value: Any, ctx: str) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
    ):
        raise ValueError(
            f"claudeVisionCritic: expected a finite number at {ctx}, got {_describe(value)}"
        )
    return float(value)


def _as_non_empty_string(value: Any, ctx: str) -> str:
    if not isinstance(value, str) or len(value.strip()) == 0:
        raise ValueError(
            f"claudeVisionCritic: expected a non-empty string at {ctx}, got {_describe(value)}"
        )
    return value


def _as_vec3(value: Any, ctx: str) -> Vec3:
    if not isinstance(value, list) or len(value) != 3:
        raise ValueError(
            f"claudeVisionCritic: expected a [x, y, z] array at {ctx}, got {_describe(value)}"
        )
    return (
        _as_number(value[0], f"{ctx}[0]"),
        _as_number(value[1], f"{ctx}[1]"),
        _as_number(value[2], f"{ctx}[2]"),
    )


def _describe(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, list):
        return f"array(len {len(value)})"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, str):
        return "string"
    if isinstance(value, (int, float)):
        return "number"
    return type(value).__name__
