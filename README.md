# CI Photo Time Machine

**Turn any image, image set, or video into a shareable 3D memory** — a Gaussian splat or
mesh you can explore in the browser and in XR. Part of the [Companion
Intelligence](https://ci.computer) suite: containerized, **MCP‑native**, and wired into
Companion memory and Companion OIDC.

> Point a photo (or a whole video) at it, get back a link. Open the link and step *into* the
> moment with head‑tracked parallax — or drop the 3D model into AR on your phone.

- 🧠 **MCP API** — Hermes, OpenClaw, and Claude Code can create and share 3D assets as tools.
- 🧩 **Pluggable engines** — TripoSplat (default), Apple SHARP (research), COLMAP→gsplat
  photogrammetry, with TRELLIS/Hunyuan mesh engines slotting in behind one interface.
- 🐳 **Containerized** — one `docker compose up` for the processing server + web viewer.
- 🔐 **Companion‑native** — Companion OIDC auth; created assets are written to CI‑Server /
  Hermes memory so your digital twin remembers them.
- 🕶️ **Web + XR viewer** — Spark‑powered splat viewer with a MediaPipe head‑tracked "magic
  portal," plus `<model-viewer>` for meshes with native mobile AR.

## Why this exists / what changed

This project began as a fork of Apple's **SHARP** (single‑image → 3D Gaussian Splatting) with a
Flask + React viewer. Reimagined for the Companion suite, it becomes a proper **3D processing
service**: agent‑drivable over MCP, engine‑agnostic, containerized, and authenticated.

A key reason for the redesign: **SHARP's model weights are licensed for non‑commercial research
only** (`LICENSE_MODEL`). The default engine is now **TripoSplat** (MIT — code *and* weights),
with SHARP kept as an optional, clearly labeled research/scene engine. Full trade study in
[`docs/RESEARCH.md`](docs/RESEARCH.md); system design in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Quick start (Docker)

```bash
cp .env.example .env      # set PUBLIC_BASE_URL, Companion OIDC + memory (optional)
docker compose up --build
# Viewer:  http://localhost:3000
# API:     http://localhost:8000/api/v1   (docs at /docs)
# MCP:     http://localhost:8000/mcp
```

For **local hacking without auth**, set `AUTH_DISABLED=1` (default in `.env.example`).

## Run the server directly (dev)

```bash
cd server
pip install -e .
uvicorn app.main:app --reload --port 8000
```

The API, MCP surface, input router, auth, and memory client all run **without a GPU**. Engine
*inference* (TripoSplat/SHARP/photogrammetry) needs a CUDA GPU and downloaded weights; without
them the API still works and engines return a clear "GPU/weights required" error.

## Using it

### From the web
1. Open the viewer, drop in an image, a set of images, or a video.
2. The server classifies the input, routes it to an engine, and runs the job.
3. When it finishes, the asset loads in the viewer and you get a **share link**
   (`/view/:assetId`). Enable XR for the head‑tracked portal.

### From an agent (MCP)
Point your Companion agent at `http://<host>:8000/mcp`. Tools:
`list_engines`, `image_to_3d`, `media_to_3d`, `get_job`, `list_assets`, `get_asset`,
`get_share_url`. Example intent: _"make a 3D model of the photo I just shared and send me the
link"_ → `image_to_3d` → poll `get_job` → `get_share_url`.

## Repository layout

```
server/                 FastAPI 3D processing server + MCP + engines (the new core)
  app/
    engines/            Engine protocol, registry/router, TripoSplat/SHARP/photogrammetry
    main.py routes.py mcp_server.py jobs.py storage.py memory.py auth.py models.py config.py
web-server/client/      React + Three.js + Spark web viewer (kept, evolved: /view/:id, meshes)
src/sharp/              Apple SHARP engine (bundled; research‑licensed weights)
docs/                   ARCHITECTURE.md, RESEARCH.md
companion-app.json      Companion Hub / Marketplace manifest
docker-compose.yml      Viewer + server stack
```

## Configuration

| Env var | Purpose | Default |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | Base URL used to build share links | `http://localhost:3000` |
| `AUTH_DISABLED` | Disable Companion OIDC (local dev) | `1` in `.env.example` |
| `COMPANION_OIDC_ISSUER` | OIDC issuer for token verification | — |
| `COMPANION_OIDC_AUDIENCE` | Expected token audience | — |
| `CI_MEMORY_MCP_URL` | Companion memory MCP endpoint (CI‑Server/Hermes) | — (memory off) |
| `DEFAULT_ENGINE` | Engine when none requested | `triposplat` |
| `SHARP_ENABLE_RESEARCH` | Enable the non‑commercial SHARP engine | `0` |
| `ASSET_DIR` | Where assets/jobs are persisted | `./data/assets` |

## Testing

```bash
cd server && pytest          # router, job lifecycle, API contract (no GPU)
cd web-server/client && npm test
```

## Credits & licensing

Built on the shoulders of open 3D reconstruction work — see [`docs/RESEARCH.md`](docs/RESEARCH.md)
for the full list and [`ACKNOWLEDGEMENTS`](ACKNOWLEDGEMENTS). The bundled **SHARP** model and code
are © Apple Inc. under the Apple ML Research Model License (`LICENSE_MODEL`, **non‑commercial**)
and Apple sample‑code `LICENSE`. **TripoSplat** is MIT. Verify each engine's license before
commercial deployment.
