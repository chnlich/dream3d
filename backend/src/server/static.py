"""Static asset serving for the Python backend.

- /assets/<path> serves files from ~/.cache/dream3d/assets/.
- A placeholder /static/ route is reserved for future production build serving.
"""

import os
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

assets_dir = Path.home() / ".cache" / "dream3d" / "assets"

router = APIRouter()


@router.get("/assets/{path:path}")
async def serve_asset(path: str) -> FileResponse:
    """Serve a static asset from the dream3d assets cache."""
    # Validate the client-supplied path lexically: os.path.normpath collapses
    # '..'/'.' WITHOUT following the final symlink (unlike Path.resolve()).
    # assets/<id>.glb is a symlink into the meshy cache (outside assets_dir);
    # resolving it would follow it out and falsely trip the traversal guard.
    # The guard blocks malicious URLs like /assets/../../etc/passwd, not the
    # backend's own symlinks; FileResponse then serves the symlink transparently.
    base = os.path.normpath(assets_dir)
    target = os.path.normpath(os.path.join(base, path))
    if target != base and not target.startswith(base + os.sep):
        raise HTTPException(status_code=403, detail="forbidden")
    file_path = Path(target)
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="asset not found")
    return FileResponse(
        file_path,
        media_type="model/gltf-binary",
        headers={"content-disposition": f"inline; filename=\"{file_path.name}\""},
    )


@router.get("/static/{path:path}")
async def serve_static_placeholder(path: str) -> dict[str, str]:
    """Placeholder for serving the production Vite build (dist/)."""
    raise HTTPException(
        status_code=501,
        detail=f"static build serving not implemented yet (requested: {path})",
    )
