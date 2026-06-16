"""Pydantic models mirroring src/api/contract.ts and src/scene/schema.ts."""

from typing import Literal
from pydantic import BaseModel, Field

Vec3 = tuple[float, float, float]

ObjectStatus = Literal["pending", "ready", "failed"]
IssueKind = Literal[
    "overlap",
    "floating",
    "out_of_bounds",
    "wrong_facing",
    "too_big",
    "too_small",
    "other",
]
Severity = Literal["low", "medium", "high"]
FixOp = Literal["move", "rotate", "resize", "regenerate"]


class GenerateRequest(BaseModel):
    prompt: str
    amend_rounds: int = Field(..., alias="amendRounds", ge=0)

    model_config = {"populate_by_name": True}


class Room(BaseModel):
    width: float
    depth: float
    height: float


class Transform(BaseModel):
    position: Vec3
    rotation_y_deg: float = Field(..., alias="rotationYDeg")
    scale: float

    model_config = {"populate_by_name": True}


class PlannedObject(BaseModel):
    id: str
    label: str
    meshy_prompt: str = Field(..., alias="meshyPrompt")
    approx_size: Vec3 = Field(..., alias="approxSize")
    position: Vec3
    rotation_y_deg: float = Field(..., alias="rotationYDeg")

    model_config = {"populate_by_name": True}


class ScenePlan(BaseModel):
    prompt: str
    room: Room
    objects: list[PlannedObject]


class SceneObject(BaseModel):
    id: str
    label: str
    meshy_prompt: str = Field(..., alias="meshyPrompt")
    approx_size: Vec3 = Field(..., alias="approxSize")
    transform: Transform
    glb_url: str | None = Field(default=None, alias="glbUrl")
    status: ObjectStatus

    model_config = {"populate_by_name": True}


class SceneState(BaseModel):
    room: Room
    objects: list[SceneObject]
    pass_: int = Field(..., alias="pass")

    model_config = {"populate_by_name": True}


class Pass(BaseModel):
    scene_state: SceneState = Field(..., alias="sceneState")

    model_config = {"populate_by_name": True}


class GenerateResponse(BaseModel):
    passes: list[Pass]


class LogLine(BaseModel):
    ts: int
    text: str


class JobStatus(BaseModel):
    status: Literal["running", "done", "error"]
    log: list[LogLine]
    result: GenerateResponse | None = None
    error: str | None = None
    cached: bool = False


class JobStartResponse(BaseModel):
    job_id: str = Field(..., alias="jobId")

    model_config = {"populate_by_name": True}


class Fix(BaseModel):
    op: FixOp
    delta: Vec3 | None = None
    rotation_y_deg: float | None = Field(default=None, alias="rotationYDeg")
    scale_factor: float | None = Field(default=None, alias="scaleFactor")
    new_meshy_prompt: str | None = Field(default=None, alias="newMeshyPrompt")

    model_config = {"populate_by_name": True}


class ReviewIssue(BaseModel):
    object_id: str = Field(..., alias="objectId")
    kind: IssueKind
    severity: Severity
    description: str
    fix: Fix
    source: Literal["geometry", "vision"]

    model_config = {"populate_by_name": True}


class ReviewPass(BaseModel):
    pass_: int = Field(..., alias="pass")
    screenshot_data_url: str | None = Field(default=None, alias="screenshotDataUrl")
    issues: list[ReviewIssue]
    fixes_applied: list[Fix] = Field(..., alias="fixesApplied")

    model_config = {"populate_by_name": True}
