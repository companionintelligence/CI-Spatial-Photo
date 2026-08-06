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

Both ports are overridable, which matters when several product stages boot at once and 3000/8000
are already taken. Nothing in the stage is pinned to the defaults — the 2026-08-05 re-shoot ran
entirely on 3183/8183:

```bash
uvicorn app.main:app --app-dir server --host 127.0.0.1 --port 8183 &
CI=false REACT_APP_API_BASE=http://127.0.0.1:8183 npm run build --prefix web-server/client
npx serve -s web-server/client/build -l 3183 &
# …seed the asset against :8183, then:
APP_URL=http://localhost:3183 PTM_API_URL=http://127.0.0.1:8183 npm run capture
```

`APP_URL` works as a fallback for `PTM_VIEWER_URL`, so the fleet-wide runner convention needs no
special case here. **`REACT_APP_API_BASE` must match the API port** — it is baked into the bundle
at build time, so changing the API port means rebuilding the client, not just restarting uvicorn.
`npx serve` can be any static server that does SPA fallback; without `-s`, `/view/:assetId` 404s
and the two viewer shots fail.

## Current coverage

Nine shots across seven scenes. Most scenes carry **two** of them, because several shots in one
scene cross-dissolve inside that scene — which is how a beat shows its own state change (empty →
filled, auto → chosen, panel → hidden) without cutting away.

| Shot | State |
| --- | --- |
| `create-empty`, `create-selected`, `create-engine-picked`, `create-processing` | captured |
| `memory-grid`, `memory-job` | captured |
| `gallery-assets`, `viewer-shared`, `viewer-orbit` | captured — need the **seeded asset** above |

**All nine are captured at both viewports — `ci-video status` reports "missing none".** The whole
set was re-shot in one pass on 2026-08-05 against the stage below, so there are no "capture
pending" slates left and no mixed-vintage frames.

That re-shoot was not optional. The seven previously committed shots predated three fixes on this
branch and could not be mixed with new ones: the top bar read `CI Photo Time Machine` (the repo
name, on camera in every screen frame — `MESSAGING.md` "Naming"); `[data-splat-status]` was masked
rather than hidden, so the viewer frames carried an opaque rectangle; and `renderer.setSize(…,
false)` cropped the splat canvas to its top-left ninth at dpr 3. Capturing only the two missing
shots would have shipped a cut whose product name changes between beats — which is why "just the
missing ones" is the wrong instinct whenever the committed set is marked stale. **Check the top-bar
string before assuming a partial capture is safe.**

`create-selected` and `viewer-shared` are each referenced by more than one scene. That is
deliberate: a shot shared between consecutive scenes is a hinge frame, so one beat ends on
the state the next begins with. `capture` dedupes by shot id and **the first occurrence in scene
order wins**, so if you edit one copy of a shared shot's `capture` block, edit every copy — a
divergent later copy is silently dead config.

A shared shot must still move the story *forward*. `share-link` used to run
`viewer-orbit` → `viewer-shared`, which is `orbit-memory` played backwards: the same two frames
alternating for 18s across three consecutive scenes. It is now a single `viewer-shared` beat —
the only frame that actually carries the share URL.

The asset shots need the seeded asset above, and the viewer shots additionally render a
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

Prefer **adding a shot to an existing scene** over adding a scene. Two shots in one scene
cross-dissolve across that scene's dwell, so the beat gains motion and shows causality without
making the video longer. A new scene only earns its place when a whole screen is missing.

Two things bite when writing a `capture.before` here:

- **Ordering.** `before` runs *after* `capture.waitFor`, not before it. `waitFor` must name a
  selector present on the first rendered state after `goto` — which for this app is always the
  Create tab, because `App.tsx` defaults `tab` to `create`. Navigation belongs in `before`, each
  step guarded by its own `waitFor`.
- **Never `mask` something you can hide.** `capture.mask` does not blur or crop — Playwright
  paints an opaque `#0A222E` block over the region (`video-kit/src/capture.mjs`), which inside a
  device frame reads as a UI bug. The viewer shots used to mask `[data-splat-status]` and shipped
  a teal-grey rectangle in the bottom-left of every viewer frame. They now `waitFor`
  `[data-splat-status="ready"]` as before and then hide the pill with an injected stylesheet, as
  the last `before` step so it survives the Toggle Controls re-render. Mask only what you cannot
  make deterministic.
- **The two `<select>`s.** The kit's `fill` verb cannot drive them — Playwright rejects `fill` on
  a `<select>`. Use an `eval` that sets `.value` and dispatches a bubbling `change` (React's
  `ChangeEventPlugin` listens to the native `change` for selects), then guard it with
  `select:has(option[value="…"]:checked)`. `create-engine-picked` is the worked example. Guard
  every such eval: an eval that silently no-ops still produces a screenshot, of the wrong state.

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

## Why Playwright is pinned exactly

`video/package.json` pins `playwright` to an exact version, not a range.

Captures are byte-stable — that is what makes committing the shots worthwhile, because a UI change
then lands as a reviewable image diff instead of noise. But that property only holds **within one
Chromium build**. A `^1.58.0` range resolved to 1.62.1 on one machine and rewrote every committed
shot in a repo by 0.07–0.47% of pixels: pure text antialiasing, no layout change, and completely
indistinguishable from a real UI change in review.

So the range is gone. Re-pin deliberately when you want the newer browser, and re-capture the whole
shot set in the same commit.
