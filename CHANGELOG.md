# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.0.0] — 2026-07-02

Complete reimagining as a **Companion Intelligence suite service**: a containerized,
MCP-native image/video → 3D processing server with a shareable web + XR viewer.

### Added
- **FastAPI processing server** (`server/`) with async jobs, filesystem asset store, and a
  REST API (`/api/v1`) — replaces the synchronous Flask CLI shell.
- **MCP server** at `/mcp` (`list_engines`, `image_to_3d`, `media_to_3d`, `get_job`,
  `list_assets`, `get_asset`, `get_share_url`) so Hermes / OpenClaw / Claude Code can create
  and share 3D assets as tools.
- **Pluggable engine registry + input router**: Preview (CPU, always available),
  TripoSplat (MIT, default), SHARP (research-gated), Photogrammetry (COLMAP + Brush for
  multi-image/video).
- **`.spz` transcode pipeline**: every splat's master `.ply` is compressed to Niantic spz
  (~10× smaller, keeps SH); validated end-to-end in the Spark viewer.
- **Companion integration**: Companion OIDC bearer auth (with dev bypass) and a CI-memory MCP
  client — browse memory photos/videos as input, write created assets back as memories.
- **Web viewer 2.0**: tabbed controls (Create / Explore / From Memory), gallery with
  thumbnails, `/view/:assetId` share deep links, mesh support via `<model-viewer>` (with
  mobile AR), spz-first format selection.
- **Deployment**: Dockerfiles + `docker-compose.yml`, Companion Hub/Marketplace manifest
  (`companion-app.json`), `.env.example`.
- **Docs**: `docs/ARCHITECTURE.md`, `docs/RESEARCH.md` (engine/viewer trade studies with
  licenses), `docs/API.md` (REST + MCP reference), `docs/UI-GUIDE.md` (every screen and
  button, with real screenshots and mermaid flows).
- **CI**: GitHub Actions workflow running server tests and the client production build.

### Changed
- Default single-image engine is **TripoSplat** (MIT code + weights). Apple **SHARP** remains
  bundled but is disabled unless `SHARP_ENABLE_RESEARCH=1` — its weights are licensed for
  non-commercial research only (`LICENSE_MODEL`).
- Client upgraded to `three` 0.183, TypeScript 5, `@google/model-viewer` 4; splat status badge
  moved to the bottom-left so it never overlaps the top bar.

### Known limitations
- GPU engine inference (TripoSplat / SHARP / photogrammetry) is not exercised in CI; the
  always-available CPU Preview engine covers the full create → share loop.
- CI-memory MCP tool names are configurable assumptions pending alignment with CI-Server.
- Single-process job queue and filesystem store by design; `storage.py` is the seam for a
  DB/object-store when scaling out.

## [1.x] — history

The original project: a fork of Apple's [ml-sharp](https://github.com/apple/ml-sharp) with a
Flask backend shelling out to the `sharp` CLI and a React + Three.js + Spark viewer featuring
MediaPipe head-tracked XR ("magic portal").
