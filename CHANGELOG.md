# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **Links back to Companion Intelligence** on every screen of the hosted viewer: the logo in
  the header, a footer, and "Buy Companion Core" / "Download Companion" callouts in the
  first-run card and the empty-state hero, plus Docs. The same links are in the no-JavaScript
  fallback, and `scripts/check-build.mjs` fails the build if any of them goes missing.
- **SEO basics**: canonical, Open Graph and Twitter tags, JSON-LD, `sitemap.xml`, a
  `robots.txt` Sitemap line, a real `404.html`, a maskable manifest icon and a new
  1200x630 social card.
- **Google Analytics 4, opt-in**: built in only when `GA_MEASUREMENT_ID` is set at build time
  (the workflow reads the repository variable of that name). Never committed; idempotent;
  share-link asset ids are redacted from the reported page path.
- **Traceable deploys**: the commit is the deployment's tag and message and is served at
  `/version.txt`; production deploys from a dirty tree are refused unless `--allow-dirty`.
- Security headers from the Worker: an enforced `frame-ancestors 'none'` CSP, a report-only
  full policy, and `Strict-Transport-Security`. Hashed bundles are cached for a year.
- Manrope (self-hosted) as the viewer's sans.

### Changed
- **Unknown paths are real 404s** instead of the app shell with a 200; only `/` and
  `/view/:assetId` serve the viewer. `/view/*` is `noindex`. `/docs` redirects to the public
  docs; `/redoc` and `/openapi.json` are 404 on a deployment with no server behind it.
- **CORS with auth off** (`AUTH_DISABLED=1`, the default) now allows loopback origins,
  `https://photo.ci.computer`, the origin of `PUBLIC_BASE_URL` and `ALLOWED_ORIGINS`, instead of
  every origin. With auth on it is unchanged (any origin; the bearer token is the gate).
- The server-address placeholder and doc examples use `my-server.example.com`, a host that
  cannot exist, instead of two invented `ci.computer` names that did not resolve.
- The viewer's share-link copy now says the link points at your own server.

### Fixed
- The "Toggle Theme" button, which turned the headline and dropzone text to 1.1:1 contrast
  on the dark ground. There is no light theme; the button is gone.
- "Same host as this page" on photo.ci.computer, where it could only ever fail, now hides, and
  a static deployment's 503 is explained instead of reported as "is that a server?".
- The first-run card and empty-state hero lost their top edge on a short phone screen.
- Copy link now says whether it copied; tabs are a real tablist with arrow-key movement; the
  page has header, main, nav and footer landmarks; icon buttons have names.

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
