"""Static asset serving for the Python backend.

- /assets/<path> serves files from ~/.cache/dream3d/assets/.
- A placeholder /static/ route is reserved for future production build serving.
"""

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

assets_dir = Path.home() / ".cache" / "dream3d" / "assets"

router = APIRouter()


@router.get("/assets/{path:path}")
async def serve_asset(path: str) -> FileResponse:
    """Serve a static asset from the dream3d assets cache."""
    file_path = (assets_dir / path).resolve()
    # Guard against path traversal outside the assets directory.
    if not str(file_path).startswith(str(assets_dir.resolve())):
        raise HTTPException(status_code=403, detail="forbidden")
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
