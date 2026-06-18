"""Claude-backed scene planner for Dream3D."""

import json
import math
import re
from typing import Any

from llm.claude_cli import run_claude
from pipeline.prompts import load
from scene.schema import PlannedObject, Room, ScenePlan, Vec3

MIN_OBJECTS = 3
MAX_OBJECTS = 6

SYSTEM_PROMPT = load("planner_system.md").replace("{min_objects}", str(MIN_OBJECTS)).replace("{max_objects}", str(MAX_OBJECTS))

VEC3_SCHEMA = {
    "type": "array",
    "items": {"type": "number"},
    "minItems": 3,
    "maxItems": 3,
}

SCENE_PLAN_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["room", "objects"],
    "properties": {
        "room": {
            "type": "object",
            "additionalProperties": False,
            "required": ["width", "depth", "height"],
            "properties": {
                "width": {
                    "type": "number",
                    "description": "interior size along X, meters",
                },
                "depth": {
                    "type": "number",
                    "description": "interior size along Z, meters",
                },
                "height": {
                    "type": "number",
                    "description": "ceiling height along Y, meters",
                },
            },
        },
        "objects": {
            "type": "array",
            "minItems": MIN_OBJECTS,
            "maxItems": MAX_OBJECTS,
            "description": f"{MIN_OBJECTS} to {MAX_OBJECTS} objects placed in the room",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "id",
                    "label",
                    "meshyPrompt",
                    "approxSize",
                    "position",
                    "rotationYDeg",
                ],
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "unique kebab-case id, e.g. 'sofa-1'",
                    },
                    "label": {
                        "type": "string",
                        "description": "short human label, e.g. 'Sofa'",
                    },
                    "meshyPrompt": {
                        "type": "string",
                        "description": (
                            "Single isolated object for text-to-3D: silhouette + material + archetype. "
                            "No IP/brand names, no background, no other objects."
                        ),
                    },
                    "approxSize": {
                        **VEC3_SCHEMA,
                        "description": "intended bounding box [x, y, z] in meters",
                    },
                    "position": {
                        **VEC3_SCHEMA,
                        "description": "object center [x, y, z] in world meters (floor at y=0)",
                    },
                    "rotationYDeg": {
                        "type": "number",
                        "description": "yaw in degrees; 0 faces +Z",
                    },
                },
            },
        },
    },
}


async def plan(prompt: str) -> ScenePlan:
    trimmed = prompt.strip()
    if len(trimmed) == 0:
        raise ValueError("claudePlanner.plan: prompt must be a non-empty string")

    full_prompt = "\n".join(
        [
            SYSTEM_PROMPT,
            "",
            f"Scene description: {trimmed}",
            "",
            "Respond with ONLY the JSON object — no prose, no markdown code fences. It must match this schema:",
            json.dumps(SCENE_PLAN_SCHEMA, indent=2),
        ]
    )

    text = run_claude(full_prompt, caller="planner")
    input_ = _as_record(_parse_json(text), "scene plan")
    room_raw = _as_record(input_.get("room"), "room")
    room = Room(
        width=_as_number(room_raw.get("width"), "room.width"),
        depth=_as_number(room_raw.get("depth"), "room.depth"),
        height=_as_number(room_raw.get("height"), "room.height"),
    )

    raw_objects = input_.get("objects")
    if not isinstance(raw_objects, list):
        raise ValueError(
            f"claudePlanner: expected objects[] array, got {_describe(raw_objects)}"
        )
    if len(raw_objects) < MIN_OBJECTS or len(raw_objects) > MAX_OBJECTS:
        raise ValueError(
            f"claudePlanner: expected {MIN_OBJECTS}-{MAX_OBJECTS} objects, got {len(raw_objects)}"
        )

    seen_ids: set[str] = set()
    objects: list[PlannedObject] = []
    for i, raw in enumerate(raw_objects):
        o = _as_record(raw, f"objects[{i}]")
        object_id = _as_non_empty_string(o.get("id"), f"objects[{i}].id")
        if object_id in seen_ids:
            raise ValueError(f'claudePlanner: duplicate object id "{object_id}"')
        seen_ids.add(object_id)
        objects.append(
            PlannedObject(
                id=object_id,
                label=_as_non_empty_string(o.get("label"), f"objects[{i}].label"),
                meshyPrompt=_as_non_empty_string(
                    o.get("meshyPrompt"), f"objects[{i}].meshyPrompt"
                ),
                approxSize=_as_vec3(o.get("approxSize"), f"objects[{i}].approxSize"),
                position=_as_vec3(o.get("position"), f"objects[{i}].position"),
                rotationYDeg=_as_number(
                    o.get("rotationYDeg"), f"objects[{i}].rotationYDeg"
                ),
            )
        )

    return ScenePlan(prompt=prompt, room=room, objects=objects)


def _parse_json(text: str) -> Any:
    body = text.strip()
    fence = re.search(r"```(?:json)?\s*\n?([\s\S]*?)```", body)
    if fence:
        body = fence.group(1).strip()
    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"claudePlanner: model output was not valid JSON: {body[:1000]}"
        ) from exc


def _as_record(value: Any, ctx: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(
            f"claudePlanner: expected an object at {ctx}, got {_describe(value)}"
        )
    return value


def _as_number(value: Any, ctx: str) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
    ):
        raise ValueError(
            f"claudePlanner: expected a finite number at {ctx}, got {_describe(value)}"
        )
    return float(value)


def _as_non_empty_string(value: Any, ctx: str) -> str:
    if not isinstance(value, str) or len(value.strip()) == 0:
        raise ValueError(
            f"claudePlanner: expected a non-empty string at {ctx}, got {_describe(value)}"
        )
    return value


def _as_vec3(value: Any, ctx: str) -> Vec3:
    if not isinstance(value, list) or len(value) != 3:
        raise ValueError(
            f"claudePlanner: expected a [x, y, z] array at {ctx}, got {_describe(value)}"
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
