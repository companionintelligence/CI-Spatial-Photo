# CI Photo Time Machine — processing server

FastAPI service that turns images/videos into 3D assets and exposes both a REST API (for the
browser) and an **MCP server** (for Companion agents), backed by a pluggable engine registry.

See the repo root [`README.md`](../README.md), [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md),
and [`docs/RESEARCH.md`](../docs/RESEARCH.md).

## Dev

```bash
pip install -e ".[dev,mcp]"
uvicorn app.main:app --reload --port 8000     # REST at /api/v1, MCP at /mcp, docs at /docs
pytest                                        # no GPU required
```

The API, router, auth, memory client, and the CPU **preview** engine run without a GPU. The
`triposplat`, `sharp`, and `photogrammetry` engines report themselves unavailable (with
guidance) until their runtimes/weights are installed in the image.

## Layout

| File | Role |
| --- | --- |
| `app/main.py` | FastAPI app; mounts REST + MCP over a shared core |
| `app/routes.py` | REST API (`/api/v1`) |
| `app/mcp_server.py` | MCP tools (`image_to_3d`, `media_to_3d`, `get_job`, …) |
| `app/jobs.py` | async job manager |
| `app/engines/` | `Engine` protocol, registry/router, preview/triposplat/sharp/photogrammetry |
| `app/storage.py` | filesystem job/asset store |
| `app/memory.py` | Companion memory MCP client (read media / write assets) |
| `app/auth.py` | Companion OIDC bearer verification |
| `app/plywriter.py` | 3DGS `.ply` writer used by the preview engine |
