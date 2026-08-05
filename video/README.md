# Photo Time Machine — product video

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

Generates a **16:9 desktop cut** and a **9:16 mobile cut** of Photo Time Machine's FTUE and major
screens, from this repo's own UI. Both are produced from [`storyboard.json`](storyboard.json).

## Videos are built locally, and not stored

The cut is a **build output**. It is not built by GitHub Actions, and the MP4s are not kept
anywhere — no workflow artifacts, no committed `.mp4`, no release assets. Render one when you
need it, then delete it.

The runner lives in CI-Engineering, cloned beside this repo:

```bash
node tools/make-videos.mjs --list                 # every product, and how many screens each has
node tools/make-videos.mjs photo-time-machine     # this repo, both cuts
```

It exports `video/` from `origin/main` into a scratch directory and renders there, so it never
depends on — or writes into — whatever your checkout happens to be doing. Output lands in
`~/Movies/CI-Product-Videos/photo-time-machine/`, outside every repo.

It resolves `@companionintelligence/video-kit` straight from the CI-Common checkout on disk, so
there is no npm registry, no token, and no `403 read_package` — which is exactly what used to
stop a hosted runner from ever producing a shot. You need `ffmpeg` + `ffprobe` on `PATH` and
Node 22+; nothing else.

By default the render uses the screenshots already committed under
[`assets/shots/`](assets/shots), so nothing has to be running. Re-shooting them means booting
the stage below by hand — this product has no automated stage entry, because the two processes
need `pip install -e ./server` and a CRA build first.

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

Three of the shots also need **one seeded asset**, or Explore films "No 3D memories yet", the
viewer has nothing to load, and the share footer never mounts. Seed it through the real API with
`engine=preview` — the only engine that needs neither CUDA nor downloaded weights:

```bash
curl -sf -X POST http://127.0.0.1:8000/api/v1/jobs \
  -F files=@video/assets/media/porch-1998.png -F engine=preview -F intent=auto
# poll GET /api/v1/jobs/<job_id> until status is "done"
```

Overrides: `PTM_VIEWER_URL` (default `http://localhost:3000`) and `PTM_API_URL`
(default `http://localhost:8000`) in [`capture.config.mjs`](capture.config.mjs).

## Current coverage

| Shot | State |
| --- | --- |
| `create-empty`, `create-selected`, `create-processing` | capture spec written — run `npm run capture` against the stage |
| `gallery-assets`, `viewer-shared` | **no capture spec** — render as "capture pending" slates |

The two pending shots need the **seeded asset** above, and the viewer shot additionally renders a
Three.js + Spark **WebGL2 canvas** that is outside the kit's byte-stability guarantee. Every
determinism hazard is catalogued at the top of [`capture.config.mjs`](capture.config.mjs).

Note that **every screen except `/view/:assetId` is interaction state on `/`** — routing is a
hand-rolled regex (`parseViewId()` in `web-server/client/src/App.tsx`), not a router. Drive new
beats with `capture.before`, not with `capture.path`.

## Driving the kit directly

`node tools/make-videos.mjs photo-time-machine` runs all of this for you. Reach for the
individual steps when you are re-shooting screens or debugging one of them — they need the kit
resolvable from here, which the runner otherwise handles by pointing at the CI-Common checkout.

```bash
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

`assets/shots/*.png` and `assets/audio/*.mp3` **are** committed. They are **inputs**, not output:
they let anyone render a cut without booting the server and the viewer first, and captures are
byte-stable, so a diff in them means the UI genuinely changed — review it like any other diff and
update the storyboard's captions if a screen's meaning moved.

`out/` and the MP4s in it are **not** committed and are not stored anywhere else either. Only the
video is ephemeral.

See [CI-Engineering `projects/product-video-pipeline/`](https://github.com/companionintelligence/CI-Engineering/tree/main/projects/product-video-pipeline)
for the full contract.
