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

**`video/make.sh` boots all of it and re-shoots every screenshot.** Use it; the manual steps
below are what it does, kept here because you need them when something in the middle breaks.

```bash
video/make.sh --no-render                       # stage, capture, build, check — no MP4
video/make.sh --only viewer-orbit               # re-shoot one shot
video/make.sh --keep-up                         # leave the stage running afterwards
video/make.sh                                   # …and render, which you do not do on a laptop
```

`make.sh` is **generic and byte-identical in every product repo** — it ships as
`template/make.sh` in video-kit. Do not edit it here; fix it in the kit and roll it out, or the
copies drift, which is how several repos ended up with a Playwright guard that checked the wrong
thing. To see what this repo has diverged by:

```bash
diff video/make.sh <CI-Common>/packages/video-kit/template/make.sh
```

Everything Photo-Time-Machine-specific lives in [`video/stage.sh`](stage.sh), which defines
`stage_up` and `stage_down`. It installs `server/` into a venv outside the repo, points
`ASSET_DIR` outside the repo so a capture leaves no splats in the working tree, rebuilds the CRA
bundle against whichever API port `pick_port` landed on, asserts the SPA fallback is really
there, and seeds one asset through the real `POST /api/v1/jobs` before capture starts. Ports
relocate around anything already bound; override the preferred ones with `PTM_API_PORT` /
`PTM_VIEWER_PORT`, and the scratch directory with `PTM_WORK_DIR`.

`make.sh` finds the kit at `$CI_WORKSPACE/CI-Common/packages/video-kit`, or by walking up from
the repo — **look at what that checkout is on** before trusting a render. A CI-Common clone
parked on an old branch renders last week's brand without a word of warning.

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
set was re-shot in one pass on 2026-08-07 with `video/make.sh`, so there are no "capture pending"
slates left and no mixed-vintage frames.

No re-shoot was optional, and all three were whole-set:

- **2026-08-05.** Seven committed shots predated three fixes: the top bar read `CI Photo Time
  Machine` (the repo name, on camera in every frame — `MESSAGING.md` "Naming");
  `[data-splat-status]` was masked rather than hidden, so viewer frames carried an opaque
  rectangle; and `renderer.setSize(…, false)` cropped the splat canvas to its top-left ninth at
  dpr 3.
- **2026-08-06.** All eighteen were invalidated by [#22](https://github.com/companionintelligence/CI-Photo-Time-Machine/pull/22)
  (the empty-state hero stopped being sliced by the panel, the mobile Engine select stopped
  clipping its own value, `Status: running — running preview` lost its stutter, gallery cards
  started leading with the source, the memory grid regained its captions) and
  [#23](https://github.com/companionintelligence/CI-Photo-Time-Machine/pull/23) (the viewer's
  default camera moved, which took `viewer-orbit` and `viewer-shared` with it — the two shots #22
  had exempted).
- **2026-08-07.** All eighteen were invalidated by
  [#32](https://github.com/companionintelligence/CI-Photo-Time-Machine/pull/32), which un-inverted
  the splat and changed five UI files besides. The headline was `viewer-orbit`: the porch deck ran
  along the TOP edge and the sun hung below the railing, so `explore-gallery` cross-dissolved from
  the **upright** gallery thumbnail straight into the **inverted** viewer — the same memory, both
  ways up, inside one scene. The other seventeen moved too, for the rest of #32: the empty-state
  watermark went `opacity-30 → 60`, the selected tab gained an accent underline, disabled
  `Create 3D` got explicit colours, Gallery gained a loading state, the `Loaded N splats` debug
  readout stopped painting, and the mobile header gained `truncate`.

Capturing only the shots you think moved ships a cut whose product name, or panel layout, or
camera changes between beats. **Whenever the committed set is marked stale, re-shoot all of it** —
one `video/make.sh` run costs less than one mixed-vintage frame in review.

`create-selected` and `viewer-shared` are each referenced by more than one scene. That is
deliberate: a shot shared between consecutive scenes is a hinge frame, so one beat ends on
the state the next begins with. `capture` dedupes by shot id and **the first occurrence in scene
order wins**, so if you edit one copy of a shared shot's `capture` block, edit every copy — a
divergent later copy is silently dead config.

A shared shot must still move the story *forward*. `share-link` used to run
`viewer-orbit` → `viewer-shared`, which is `orbit-memory` played backwards: the same two frames
alternating for 18s across three consecutive scenes. It is now a single `viewer-shared` beat —
the only frame that actually carries the share URL.

**The engine the picker shows must be the engine the rest of the film runs.**
`create-engine-picked` drives the two selects off auto, and it used to pick `triposplat` and
`Object (full 3D)` — while the very next scene prints `Status: running — reconstructing with
preview`, the gallery tile reads `Splat · Preview`, and the orbited splat is a `preview` render.
The film chose one engine on camera and ran another. It now picks `preview` and `Scene (portal)`,
which is what this stage can honestly produce: `preview` is the only engine needing neither CUDA
nor downloaded weights, and its own capability blurb calls it a *flat textured Gaussian plane* —
a portal, not a full 3D object. The beat still shows a real two-field state change, so the
cross-dissolve keeps its causality. If you ever stage a GPU box, change the pick and the seeded
asset's `engine=` together, in one commit.

The asset shots need the seeded asset above, and the viewer shots additionally render a
Three.js + Spark **WebGL2 canvas** that is outside the kit's byte-stability guarantee. Every
determinism hazard is catalogued at the top of [`capture.config.mjs`](capture.config.mjs).

In practice that canvas **is** reproducible on one machine: two full passes on 2026-08-07, booted
independently and landing on different API ports, produced all eighteen shots byte-for-byte
identical except the one shot whose storyboard entry had deliberately changed. Re-shooting twice
and diffing the hashes is the cheapest available proof that a change is scoped to what it claims —
`check` cannot tell you that, because it counts files and looks for slates.

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

### Why `memory-grid` has no `focus` rect any more

It used to, framing `x: 0.005, w: 0.37` — the left third, which was where the control panel sat
when the panel was pinned top-left. The empty-state recompose moved the panel to the right of a
centred composition, so that rect started framing the **hero** instead. The move had to go, not
just move, and the reason is geometric rather than editorial:

`focusState` in the kit **contains** the declared rectangle (`min()`, never `cover()`), so a
16:9 window that holds all of a `0.374 x 0.621` panel is `0.621` wide — 62% of the frame. The
panel's right edge is at `0.912`, so that window cannot be centred on it without running off the
canvas; it slides back to `x = 0.378` and slices the hero mid-word. Tightening it until the left
edge clears the hero (`0.4747`) needs `h <= 0.50`, which then cuts through the second row of
photo tiles. Either way something is sliced, which is the exact defect class PR #32 fixed.

So the scene keeps the legacy 1.045 push and shows the whole frame. That is affordable now: the
composition is no longer 85% black, the grid occupies a real share of the frame, and each tile
renders ~205px wide in the 1920 cut — legible without a crop. **Check this with
`ci-video focus-preview --scene <id>` before adding a rect back**; it prints the window a rect
will actually produce and says out loud when the subject ends up anchored to a canvas edge.

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

### The stand-in memory library

`assets/memory/*.jpg` are the six thumbnails behind the `GET /api/v1/memory/media` stub — the
Companion Memory library the From Memory grid browses, which a capture machine does not have.
They are **synthetic, not photographs**: drawn by [`assets/memory/generate.py`](assets/memory/generate.py)
in the same style as `assets/media/porch-1998.png`, and committed next to the generator so their
origin is impossible to mistake. No caption may describe them as someone's photos.

```bash
python3 video/assets/memory/generate.py    # needs numpy + Pillow; deterministic
```

Each scene is composed for the title it is served under (`capture.config.mjs`, `MEMORY_MEDIA`).
That matters now that `MemoryPicker` renders those titles: before this, all six were recolourings
of one mountain ridge, so "Skyline from the roof" and "Beach, Outer Banks" were the same picture.
Change a title and change its scene in the same commit.

### The film says "photograph" exactly once, and never about this file

`assets/media/porch-1998.png` is the image that goes in — and it is a drawn illustration, under a
product whose own hero reads "Turn a photo into a 3D memory". That is uncomfortable, and it was
decided rather than ignored.

**It stays synthetic.** A user's own photographs are the one input Companion Intelligence cannot
supply, which is exactly why the stub exists; swapping in a real photograph would put a third
party's image, or somebody's actual porch, into a committed and redistributable marketing asset —
and it would buy nothing. The Preview engine lays whatever it is handed onto a plane, so a more
photographic input would only make a flat plate *look* more like a reconstruction. That is the
opposite of what this cut is trying to be honest about.

**So the script carries the seam instead of hiding it.** Exactly one line uses the word
photograph — the opening, "A photograph has no depth. Your own server works it out." — and it is a
statement about photographs in general, not a claim about this file. Every line that points at
what is on screen says *image*, *picture*, *file*, *library* or *tile*. The opening card is titled
"1998. The porch, the sun going down.", which describes the picture without classifying it, and it
agrees with what the app itself prints on camera: `porch-1998` in the dropzone, "Porch at sunset,
1998" in the memory grid.

Keep that rule when editing `storyboard.json`. It is the rule the stand-in library above is already
under, extended to the input.

## The capture needs hardware GL

`capture.config.mjs` sets `launch: { channel: "chromium" }`, which needs **video-kit >= 0.14.0**.
On an older kit the key is silently ignored, capture falls back to SwiftShader, and the three
viewer shots fail while leaving their previous PNGs on disk — 15 of 18, with
`assets/shots/.capture-receipt.json` the only sign. `make.sh` announces the kit version on every
run; read it before trusting a re-capture. The reasoning is in the comment on that key.

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

**A pin only binds if the copy that answers is the pinned one.** Node's resolution walks *up*, so
a `playwright` anywhere above `video/` satisfies `require.resolve` and the pin is never consulted —
no install happens, and the capture quietly runs on whatever the parent directory had. Checking
that Playwright *resolves* proves nothing; only the resolved version does. `video/make.sh` asks for
the version from inside `video/` and refuses to capture on a mismatch, and video-kit ≥ 0.5 makes
the same check in `capture` and `doctor`. To see it yourself:

```bash
cd video && node -p "require('playwright/package.json').version"   # must equal the pin
```

`npm install playwright` inside `video/` does not work: `video/package.json` lists the private
`@companionintelligence/video-kit`, and npm demands a token for the whole tree before it installs
anything. `make.sh` installs through a throwaway manifest that names nothing private, and links
the result in.
