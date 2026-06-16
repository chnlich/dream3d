# dream3d Python backend

FastAPI development backend for dream3d. This is a mock pipeline used during
Phase 0.5; it does not call Meshy or Claude.

## Setup

```bash
cd backend
uv sync
```

## Run the backend

```bash
cd backend
uv run uvicorn src.main:app --host 0.0.0.0 --port 8000 --reload
```

The API will be available at `http://localhost:8000`.

## Run the frontend against this backend

From the repo root:

```bash
npm install          # if you have not already
npm run dev -- --host
```

The Vite dev server proxies `/api` and `/assets` to `http://localhost:8000`, so
the studio UI talks to the Python backend automatically.

Open:

```
http://aws-ohio-slurm-login.onca-snapper.ts.net:5173/studio.html
```

## Configuration

Copy `config/local.example.json` to `config/local.json` and fill in your Meshy
key, or set the `MESHY_API_KEY` environment variable to override the file. The
mock pipeline does not spend credits, but the app still validates that a key is
configured so startup behavior matches the real backend.
