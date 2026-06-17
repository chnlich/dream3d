"""Tests for publishing local generated assets under /assets."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from scene.schema import GenerateResponse, Pass, Room, SceneObject, SceneState, Transform
from server import asset_bridge


def _object(
    id_: str,
    glb_url: str | None,
    *,
    status: str = "ready",
) -> SceneObject:
    return SceneObject(
        id=id_,
        label=id_,
        meshy_prompt=id_,
        approx_size=(1.0, 1.0, 1.0),
        transform=Transform(position=(0.0, 0.5, 0.0), rotation_y_deg=0.0, scale=1.0),
        glb_url=glb_url,
        status=status,
    )


def _response(objects: list[SceneObject]) -> GenerateResponse:
    return GenerateResponse(
        passes=[
            Pass(
                scene_state=SceneState(
                    room=Room(width=4.0, depth=4.0, height=3.0),
                    objects=objects,
                    pass_=0,
                )
            )
        ]
    )


def test_ready_local_glb_is_symlinked_and_rewritten(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source.glb"
    source.write_bytes(b"glb")
    assets_dir = tmp_path / "assets"
    monkeypatch.setattr(asset_bridge, "assets_dir", assets_dir)
    response = _response([_object("chair/one", str(source))])

    result = asset_bridge.publish_scene_assets(response)

    link = assets_dir / "chair-one.glb"
    assert link.is_symlink()
    assert os.path.realpath(link) == os.path.realpath(source)
    assert result.passes[0].scene_state.objects[0].glb_url == "/assets/chair-one.glb"


def test_remote_assets_existing_assets_missing_files_and_non_ready_are_unchanged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source.glb"
    source.write_bytes(b"glb")
    monkeypatch.setattr(asset_bridge, "assets_dir", tmp_path / "assets")
    objects = [
        _object("remote-http", "http://example.test/a.glb"),
        _object("remote-https", "https://example.test/b.glb"),
        _object("served", "/assets/served.glb"),
        _object("missing", str(tmp_path / "missing.glb")),
        _object("pending", str(source), status="pending"),
    ]
    original_urls = [obj.glb_url for obj in objects]

    result = asset_bridge.publish_scene_assets(_response(objects))

    assert [obj.glb_url for obj in result.passes[0].scene_state.objects] == original_urls
    assert not (tmp_path / "assets").exists()
