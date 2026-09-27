# CI Photo Time Machine — Architecture

Turn **any image, image set, or video** into a **shareable 3D asset** (Gaussian splat or
mesh), viewable in the browser and in XR — driven by an **MCP API** and wired into the
**Companion Intelligence** suite (memory, Hub/Marketplace, Companion OIDC).

This document describes the reimagined system. For the model/viewer trade studies behind these
choices, see [`RESEARCH.md`](./RESEARCH.md).

---

## 1. What changed and why

The original app is Apple SHARP behind a Flask CLI‑shell + a React/Three.js/Spark viewer. Three
problems for a Companion Intelligence app:

1. **License:** SHARP's weights are non‑commercial research only — wrong posture for a
   marketplace app.
2. **Not agent‑native:** a bespoke REST shell can't be driven by Hermes/OpenClaw/Claude Code.
   The suite's contract is **MCP**.
3. **Not a service:** synchronous subprocess, no jobs, no auth, no persistence, not
   containerized.

The reimagined system keeps the good parts (the Spark viewer + MediaPipe head‑tracked "magic
portal", the `.ply` splat pipeline) and rebuilds around three principles:

- **MCP‑first.** Every capability is an MCP tool; REST is a thin sibling for the browser.
- **Pluggable engines.** A registry + input router picks the right model per input; models are
  adapters, swappable without touching the API/viewer.
- **Companion‑native.** Docker image for the Hub/Marketplace, Companion OIDC for auth, and the
  CI memory MCP as the system of record for created assets.

---

## 2. Component overview

```
                        ┌──────────────────────────────────────────────────────────┐
                        │                Companion Intelligence suite                │
   Hermes / OpenClaw /  │   CI-Server (Memory / Digital Twin)   Companion OIDC       │
   Claude Code (agents) │        ▲  MCP (memory read/write)        ▲  OIDC/JWKS      │
                        └────────┼───────────────────────────────────┼──────────────┘
            │ MCP tools          │                                    │
            ▼                    │                                    │
┌───────────────────────────────┼────────────────────────────────────┼──────────────┐
│  CI Photo Time Machine  (single Docker image / compose stack)        │              │
│                                │                                    │              │
│  ┌────────────────┐   ┌────────┴─────────┐   ┌──────────────────────┴───────────┐  │
│  │  MCP server    │   │  Memory client   │   │  Auth (Companion OIDC bearer)     │  │
│  │  (MCPServer)   │   │  (MCP → CI mem)  │   │  JWKS verify + dev bypass         │  │
│  └───────┬────────┘   └────────┬─────────┘   └──────────────────────┬───────────┘  │
│          │  shared core         │                                   │              │
│  ┌───────┴──────────────────────┴───────────────────────────────────┴──────────┐  │
│  │                          Job manager (async queue)                           │  │
│  │   classify input → route to engine → run → transcode → persist → notify mem  │  │
│  └───────┬───────────────────────────────────────────────────────┬─────────────┘  │
│          │                                                         │                │
│  ┌───────┴─────────┐   ┌───────────────────────┐   ┌──────────────┴─────────────┐  │
│  │ Engine registry │   │  Asset store (disk)   │   │  REST API (FastAPI)        │  │
│  │  + input router │   │  jobs/ assets/ meta   │   │  upload, poll, fetch, share│  │
│  └──┬───────┬──────┘   └───────────────────────┘   └──────────────┬─────────────┘  │
│     │       │                                                     │                │
│  ┌──┴──┐ ┌──┴───────┐ ┌───────────┐ ┌───────────────┐            │ static + /view │
│  │Tripo│ │  SHARP   │ │ Photogram │ │ (TRELLIS /    │            ▼                │
│  │Splat│ │(research)│ │ COLMAP+gs │ │  Hunyuan …)   │   ┌────────────────────────┐ │
│  └─────┘ └──────────┘ └───────────┘ └───────────────┘   │  Web viewer (React)    │ │
│   MIT      non-comm.    Apache-2.0     pluggable        │  Spark splats + XR     │ │
│                                                         │  <model-viewer> meshes │ │
│                                                         └────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Processing server (`server/`, FastAPI + Python)
The heart. One process exposes **both** a REST API (for the browser) and an **MCP server**
(for agents), backed by a shared core: job manager, engine registry/router, asset store,
memory client, OIDC auth.

- **Input router** classifies the upload — single image / multi‑image / video — and (for single
  images) an `intent` hint (`object` vs `scene`) to pick the engine. See
  `server/app/engines/registry.py`.
- **Job manager** runs work asynchronously so uploads return immediately with a `job_id`; state
  transitions `queued → running → done | error`. GPU work never blocks the request thread.
- **Engines** implement one `Engine` protocol (`can_handle`, `run`). Bundled adapters:
  `TripoSplatEngine` (default), `SharpEngine` (research‑gated), `PhotogrammetryEngine`
  (COLMAP→gsplat, video/multi‑image), `DepthImageEngine` and `DepthVideoEngine` (monocular
  depth → back‑projected Gaussians, CPU‑viable). Adding TRELLIS/Hunyuan/4DGS = one new file +
  register.
- **Multi‑model engines.** An engine that wraps a family of interchangeable checkpoints
  advertises them in `EngineCapabilities.models` and takes the choice from
  `JobInput.requested_model`, rather than registering one engine per checkpoint. Six
  near‑identical rows in an engine picker would be noise, and a single `available` boolean on
  the engine cannot express "Small is ready, Large is a 1.3 GB download away". See
  [`DEPTH-ENGINES.md`](./DEPTH-ENGINES.md).
- **Asset store** persists a master artifact (`.ply` / `.glb`), transcodes (`.spz`/`.sog` for
  splats), a thumbnail, and a metadata record on disk under a stable `asset_id`.

### 2.2 MCP server (`server/app/mcp_server.py`)
The agent‑facing contract. Tools (see §4) let Hermes/OpenClaw/Claude Code create and manage 3D
assets. This is what makes the app a first‑class citizen of the suite rather than a website.

### 2.3 CI memory client (`server/app/memory.py`)
An MCP **client** that writes an asset "memory" to the Companion memory server (CI‑Server /
Hermes memory MCP) whenever an asset is created: what was captured, when, the share URL, and
tags. Configured via `CI_MEMORY_MCP_URL`. If unset, memory writes are skipped (fully local mode).

### 2.4 Auth (`server/app/auth.py`)
Companion **OIDC** bearer‑token verification against a configured issuer's JWKS
(`COMPANION_OIDC_ISSUER`, `COMPANION_OIDC_AUDIENCE`). A dev bypass (`AUTH_DISABLED=1`) keeps
local hacking friction‑free. Standard OIDC so it works with whatever provider the Companion
server runs.

### 2.5 Web viewer (`web-server/client/`, React + Three.js)
Kept and evolved. A shareable `/view/:assetId` route loads an asset by id and renders it with
**Spark** (splats, incl. the MediaPipe head‑tracked portal + WebXR) or **`<model-viewer>`**
(meshes). The upload UI now talks to the job API and polls to completion.

---

## 3. REST API (browser‑facing)

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/jobs` | Create a job. Multipart: one/many images or a video + optional `engine`, `intent`, `format`. Returns `{ job_id }`. |
| `GET` | `/api/v1/jobs/{job_id}` | Job status + (when done) the resulting `asset_id`. |
| `GET` | `/api/v1/assets` | List assets (paginated) for the authenticated user. |
| `GET` | `/api/v1/assets/{asset_id}` | Asset metadata (kind, formats, dimensions, share URL). |
| `GET` | `/api/v1/assets/{asset_id}/file?format=spz\|ply\|glb\|sog` | Download an artifact. |
| `GET` | `/api/v1/assets/{asset_id}/thumbnail` | Preview image. |
| `GET` | `/api/v1/engines` | List available engines + capabilities. |
| `GET` | `/healthz` | Liveness. |

All `/api/v1/*` routes require a valid Companion OIDC bearer token unless `AUTH_DISABLED=1`.

## 4. MCP tools (agent‑facing)

| Tool | Description |
| --- | --- |
| `list_engines` | Available engines and what inputs/outputs each supports. |
| `image_to_3d` | Create a 3D asset from an image (path or URL). Args: `source`, `intent?`, `engine?`, `format?`. Returns `job_id`. |
| `media_to_3d` | Create from multiple images or a video (paths/URLs). Returns `job_id`. |
| `get_job` | Poll a job's status; returns `asset_id` when done. |
| `list_assets` | List created assets with share URLs. |
| `get_asset` | Full metadata for one asset, incl. `share_url` and available formats. |
| `get_share_url` | Convenience: the public `/view/:assetId` URL for an asset. |

Design intent: an agent can say _"turn the photo I just referenced into a 3D model and give me a
link"_ → `image_to_3d` → poll `get_job` → `get_share_url`, and the result is simultaneously
written to Companion memory so the digital twin remembers it.

## 5. Asset & job data model

```jsonc
// Asset metadata (server/app/models.py)
{
  "asset_id": "a_9f2c…",
  "owner": "liam@ci.computer",          // OIDC subject/email
  "kind": "splat",                       // "splat" | "mesh"
  "engine": "triposplat",
  "source": { "type": "image", "count": 1, "filenames": ["cat.jpg"] },
  "temporal": false,                     // reserved for 4D/dynamic splats
  "formats": { "ply": "…", "spz": "…", "glb": null, "sog": null },
  "thumbnail": "thumb.webp",
  "share_url": "https://<host>/view/a_9f2c…",
  "created_at": "2026-07-02T12:00:00Z",
  "tags": ["memory", "3d", "triposplat"]
}
```

Jobs carry `{ job_id, owner, status, engine, error?, asset_id? }` and a progress message.

## 6. Deployment

- **`server/Dockerfile`** — Python + engines. CUDA base for GPU; CPU‑only still runs the API,
  MCP, router, and (slow) CPU‑capable engines.
- **`web-server/client`** — static build served by the viewer container (nginx) or by the API.
- **`docker-compose.yml`** — wires viewer + server, mounts a model‑weights volume and an asset
  volume, and passes Companion env (`COMPANION_OIDC_*`, `CI_MEMORY_MCP_URL`, `PUBLIC_BASE_URL`).
- **`companion-app.json`** — Marketplace/Hub manifest: image, ports, the MCP endpoint it
  exposes, the memory scope it requests, and OIDC config. This is how the Hub installs and wires
  the app.

## 7. What ships in this iteration vs. later

**This iteration (scaffold + integration surface, GPU‑optional):**
- FastAPI server: jobs, asset store, REST, engine registry + input router.
- MCP server with the tools above; CI memory client; Companion OIDC middleware.
- Engine adapters: TripoSplat (default), SHARP (research‑gated, wraps the bundled CLI),
  Photogrammetry (COLMAP→gsplat), and the depth engines (`depth-image`, `depth-video`, with six
  selectable checkpoints) — each with a clean `Engine` interface and clear GPU/weights
  boundaries.
- Docker + compose + marketplace manifest; viewer share route + mesh support.
- `.spz` transcode (`server/app/transcode.py`): every splat's master `.ply` is compressed to
  Niantic spz (~10× smaller) after the engine runs; the viewer prefers spz on the wire.
- Tests for the router, job lifecycle, API contract, and spz round-trip (no GPU needed).

**Later:** in‑process → external queue (RQ/Celery) for multi‑GPU; `.sog` transcode; TRELLIS/
Hunyuan mesh engines; 4DGS temporal splats; VGGT pose init; SuperSplat‑style in‑browser cleanup.

> **Note on running the models:** engine *inference* needs a GPU and downloaded weights, so it is
> not exercised in CI. The server, router, MCP surface, auth, memory client, and viewer are fully
> functional and tested without a GPU; engines degrade gracefully with a clear "weights/GPU
> required" error when their runtime isn't present.
>
> The depth engines are the partial exception: they run on CPU with a ~100 MB download, so
> `pip install '.[depth]'` is enough to get real reconstructed geometry out of the stack on a
> laptop. Their maths (normalisation, back-projection, edge rejection, temporal alignment) is
> pure numpy and *is* covered in CI — only the neural network is mocked.
