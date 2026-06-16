"""FastAPI application factory for the dream3d Python backend."""

import logging
import sys
from contextlib import asynccontextmanager
from pathlib import Path

# Make sibling source packages importable when uvicorn loads this module directly.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.generate import create_generate_router
from config import load_config
from server.job_store import JobStore
from server.static import router as static_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    # Load config eagerly so missing keys fail fast at import/start time.
    load_config()

    store = JobStore()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        # Load historical jobs and mark any still-running ones as errored.
        historical = store.load_historical_jobs()
        if historical:
            logging.getLogger(__name__).info(
                "Loaded %d historical job(s)", len(historical)
            )
        yield

    app = FastAPI(title="dream3d-backend", lifespan=lifespan)

    # CORS is permissive in local dev mode; the production build will be served
    # behind the same origin and does not rely on this.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(create_generate_router(store))
    app.include_router(static_router)

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
