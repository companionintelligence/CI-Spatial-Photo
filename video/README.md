# Photo Time Machine — product video

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

Generates a **16:9 desktop cut** and a **9:16 mobile cut** of Photo Time Machine's FTUE and major
screens, from this repo's own UI. Both are produced from [`storyboard.json`](storyboard.json).

## The stage

The capture stage is **two processes**, exactly as in [`docker-compose.yml`](../docker-compose.yml).
From the repo root:

```bash
# 1. processing server — REST /api/v1, MCP /mcp, /healthz. AUTH_DISABLED defaults to true.
pip install -e ./server
uvicorn app.main:app --app-dir server --host 127.0.0.1 --port 8000

# 2. viewer — REACT_APP_API_BASE is baked in at CRA BUILD time, so it goes on the build.
CI=false REACT_APP_API_BASE=http://127.0.0.1:8000 npm run build --prefix web-server/client
npx serve -s web-server/client/build -l 3000     # -s gives the /view/:assetId SPA fallback
```

The SPA is an empty shell without the server: `CreatePanel` fills its Engine select from
`GET /api/v1/engines` on mount, and Explore / From Memory are pure API views.
`.github/workflows/video.yml` runs exactly these commands.

Overrides: `PTM_VIEWER_URL` (default `http://localhost:3000`) and `PTM_API_URL`
(default `http://localhost:8000`) in [`capture.config.mjs`](capture.config.mjs).

## Current coverage

| Shot | State |
| --- | --- |
| `create-empty`, `create-selected`, `create-processing` | capture spec written — run `npm run capture` against the stage |
| `gallery-assets`, `viewer-shared` | **no capture spec** — render as "capture pending" slates |

The two pending shots need a **seeded asset**, which this repo has no fixture or seed script for,
and the viewer shot additionally renders a Three.js + Spark **WebGL2 canvas** that is outside the
kit's byte-stability guarantee. Every determinism hazard is catalogued at the top of
[`capture.config.mjs`](capture.config.mjs).

Note that **every screen except `/view/:assetId` is interaction state on `/`** — routing is a
hand-rolled regex (`parseViewId()` in `web-server/client/src/App.tsx`), not a router. Drive new
beats with `capture.before`, not with `capture.path`.

## Quick start

```bash
npm install
npx playwright install --with-deps chromium
npm run doctor        # verify node / ffmpeg / playwright / hyperframes / fonts

# with the stage above running:
npm run capture       # drive the real UI -> assets/shots/*.png (both viewports)
npm run build         # storyboard.json -> build/{landscape,portrait}/index.html
npm run check         # HyperFrames gate: lint, runtime, layout, motion, contrast
npm run render        # -> out/ci-photo-time-machine-landscape.mp4 and out/ci-photo-time-machine-portrait.mp4
```

## Editing the video

Everything editorial lives in [`storyboard.json`](storyboard.json) — scene order, durations,
captions, narration, and which screens appear. The **capture spec for each shot lives in the same
file**, so the script and the screenshots cannot drift apart.

Adding a beat is: add a scene, add its shot's `capture` block, `npm run capture -- --only <id>`,
then `npm run build && npm run render`.

## Media

Drop prepared media into `assets/media/` and point `media.music` at it. Per-scene voiceover is
picked up automatically from `assets/audio/<sceneId>.mp3`; regenerate it from the storyboard's
`narration` fields with `npm run narrate`.

## What is committed

`assets/shots/*.png` and `assets/audio/*.mp3` **are** committed — they are the record of what the
product looked like, and captures are byte-stable, so a diff in them means the UI genuinely
changed. `out/` is not committed.

See [CI-Engineering `projects/product-video-pipeline/`](https://github.com/companionintelligence/CI-Engineering/tree/main/projects/product-video-pipeline)
for the full contract.
