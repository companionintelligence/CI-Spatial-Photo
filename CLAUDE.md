# CI Spatial Photo — notes for Claude

Image / image-set / video → Gaussian splat or mesh, viewable in the browser and in XR.
FastAPI + MCP processing server, React + Three.js + Spark viewer. See `README.md` for the
product picture and `docs/ARCHITECTURE.md` for the design.

## Layout

| Path | What lives there |
| --- | --- |
| `server/app/` | The core: FastAPI routes, MCP server, job manager, storage, engines |
| `server/app/engines/` | Engine protocol + registry/router, TripoSplat, SHARP, photogrammetry, depth |
| `web-server/client/` | The viewer (CRA — `react-scripts`, not Vite) |
| `src/sharp/` | Bundled Apple SHARP. Research-licensed weights; treat as vendored |
| `web-server/backend/` | The original Flask prototype. Superseded by `server/`; don't build on it |
| `worker/` + `wrangler.toml` | Cloudflare Worker serving photo.ci.computer (static; proxying is opt-in) |

## Environment

A `SessionStart` hook (`.claude/hooks/session-start.sh`) prepares remote sessions: a
`.venv` at the repo root with `server[dev,mcp]` plus ruff and mypy, and the viewer's
npm packages. It puts `.venv/bin` on `PATH`, so `pytest` / `ruff` / `mypy` / `uvicorn`
just resolve.

Two things it deliberately skips, because both are multi-gigabyte and no test needs them:
the root `pyproject.toml` (SHARP: torch, gsplat, timm) and `server`'s `[depth]` extra.
Install `-e 'server[depth]'` only when actually working on the depth engines.

## Checks

```bash
cd server && pytest                  # router, job lifecycle, API contract, spz round-trip — no GPU
cd web-server/client && npm test     # CI=true npx react-scripts test --watchAll=false
cd web-server/client && npm run build
```

`ruff check .` reports ~287 pre-existing findings — the root `[tool.ruff]` config came from
Apple's SHARP tree and its pydocstyle `D` rules have never been satisfied by `server/`.
Don't treat that backlog as yours; keep new files clean and leave the rest alone unless
asked.

**GitHub Actions triggers in this repo are gated** (`docs/CI.md`) — pushing starts nothing,
because hosted compute was costing the org $563/month. Run checks locally; dispatch a
workflow deliberately with `gh workflow run <file> --ref <branch>`.

## Conventions

- The server runs GPU-free. Engine *inference* needs CUDA, but the API, MCP surface,
  router, auth and memory client must keep working without it — an unavailable engine
  reports `available: false` with a reason, it does not crash.
- Which server the viewer talks to is a **runtime** choice, not a build-time one.
  `utils/apiTarget.ts` owns it: every request goes through `apiUrl()` and `requestInit()`
  in `api.ts`, so nothing may reintroduce a module-level `API_BASE` constant — captured at
  load, it would keep sending requests to the previous server after the user switched.
  `REACT_APP_API_BASE` survives only as a build-time default for local dev; the deployed
  bundle is built with it *unset* so it asks. `docs/BRING-YOUR-OWN-SERVER.md` has the
  browser rules, and they are not folklore — `apiTarget.test.ts` pins them.
- Licensing is load-bearing. Non-commercial weights (SHARP, Depth Anything V2 B/L, Depth
  Pro, Video Depth Anything) stay behind an opt-in flag and must keep advertising their
  real licence. Don't route to them by default.
- Commit messages are lower-case, scoped, and describe the effect on the product
  (`fix(brand): move primary-* off retired teal`), not the mechanics of the diff.
