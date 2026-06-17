"""Bridge generated GLBs into the browser-fetchable /assets route."""

from __future__ import annotations

import os
import re
from pathlib import Path

from scene.schema import GenerateResponse

# MUST match server.static.assets_dir.
assets_dir = Path.home() / ".cache" / "dream3d" / "assets"


def publish_scene_assets(response: GenerateResponse) -> GenerateResponse:
    for pass_ in response.passes:
        for obj in pass_.scene_state.objects:
            glb_url = obj.glb_url
            if obj.status != "ready" or not glb_url:
                continue
            if (
                glb_url.startswith("http://")
                or glb_url.startswith("https://")
                or glb_url.startswith("/assets/")
            ):
                continue

            source = Path(glb_url)
            if not source.is_file():
                continue

            safe_name = re.sub(r"[^A-Za-z0-9._-]", "-", obj.id)
            if not safe_name.endswith(".glb"):
                safe_name += ".glb"

            assets_dir.mkdir(parents=True, exist_ok=True)
            target = os.path.realpath(glb_url)
            link = assets_dir / safe_name
            if link.exists() or link.is_symlink():
                link.unlink()
            os.symlink(target, link)
            obj.glb_url = "/assets/" + safe_name

    return response
