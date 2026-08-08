# Depth Engines — `depth-image` and `depth-video`

Two engines that turn a photo or a clip into a Gaussian splat using **monocular depth
estimation**, with a **choice of checkpoint** inside each. They fill the gap between the
Preview engine (instant, flat, no geometry) and photogrammetry (minutes, GPU, needs a camera
that actually moved).

| | `preview` | **`depth-image`** | **`depth-video`** | `photogrammetry` |
| --- | --- | --- | --- | --- |
| Input | 1 image | 1 image | 1 video | ≥3 images or video |
| Geometry | none (flat plane) | one depth layer | one depth layer | full reconstruction |
| Parallax | ❌ | ✅ | ✅ | ✅ |
| Sees behind the subject | ❌ | ❌ | ❌ | ✅ |
| Hardware | CPU | CPU (GPU faster) | CPU (GPU faster) | CUDA GPU |
| Typical time | <1 s | 2–10 s | 10–60 s | minutes |
| Extra install | — | `pip install '.[depth]'` | `.[depth]` + ffmpeg | COLMAP + Brush |

Implementation: [`server/app/engines/depth_image.py`](../server/app/engines/depth_image.py),
[`server/app/engines/depth_video.py`](../server/app/engines/depth_video.py),
catalog in [`depth_models.py`](../server/app/engines/depth_models.py), geometry in
[`server/app/plywriter.py`](../server/app/plywriter.py).

## What you actually get

A monocular depth model predicts one depth value per pixel. Back-projecting that through a
pinhole camera gives a **2.5D** cloud: the foreground genuinely stands in front of the
background and occludes it as you lean, but there is nothing *behind* the subject, because a
single photo never saw it. Orbit far enough and you will see the hole. Within the roughly ±20°
of head movement the XR portal uses, it reads as a real 3D moment.

This is a large step up from the Preview engine — a flat postcard has no parallax at all — and
it is a different thing from photogrammetry, which fuses many viewpoints into a closed scene.

## Choosing a model

Both engines expose their checkpoints in `GET /api/v1/engines` under a new `models` array, and
accept a `model` field on `POST /api/v1/jobs`.

### `depth-image`

| `model` | Weights | Licence | Download | Notes |
| --- | --- | --- | --- | --- |
| `depth-anything-v2-small` **(default)** | ViT-S, 24M | Apache-2.0 | ~100 MB | Seconds on CPU. The only permissively licensed Depth Anything V2 checkpoint. |
| `depth-anything-v2-base` | ViT-B, 97M | CC-BY-NC-4.0 | ~390 MB | Cleaner object boundaries. |
| `depth-anything-v2-large` | ViT-L, 335M | CC-BY-NC-4.0 | ~1.3 GB | Best relative detail; wants a GPU. |
| `midas-dpt-hybrid` | Intel DPT-Hybrid | Apache-2.0 | ~490 MB | Older, softer; a useful second opinion. |
| `midas-dpt-large` | Intel DPT-Large | Apache-2.0 | ~1.4 GB | Same family, more capacity. |
| `depth-pro` | Apple Depth Pro | Apple ML Research (non-commercial) | ~1.9 GB | **Metric** depth *and* a predicted focal length — the only true pinhole back-projection here. |

### `depth-video`

| `model` | How it runs | Licence | Notes |
| --- | --- | --- | --- |
| `depth-anything-v2-small` **(default)** | per-frame + temporal alignment | Apache-2.0 | Works with only the `[depth]` extra installed. |
| `depth-anything-v2-base` / `-large`, `midas-dpt-hybrid` / `-large` | per-frame + temporal alignment | as above | Same trade-offs as the image engine. |
| `video-depth-anything-small` | external CLI | Apache-2.0 | Purpose-built temporal network. Needs the `video-depth-anything` binary. |
| `video-depth-anything-large` | external CLI | CC-BY-NC-4.0 | GPU only. |

**Non-commercial weights are refused by default.** Depth Anything V2 Base/Large, Video Depth
Anything Large and Depth Pro all ship CC-BY-NC or Apple-research weights, and this server takes
the same posture with them as it does with SHARP: set `DEPTH_ALLOW_NONCOMMERCIAL=1` to enable
them for research use. Until you do, `models[].available` is `false` for those entries with the
env var named in `unavailable_reason`.

## Using it

### REST

```bash
# List what is installed, licensed and cached
curl -s localhost:8000/api/v1/engines | jq '.engines[] | select(.name=="depth-image")'

# Run a specific checkpoint
curl -F files=@photo.jpg \
     -F engine=depth-image \
     -F model=midas-dpt-hybrid \
     localhost:8000/api/v1/jobs
```

`model` is optional. Omit it and the engine uses `DEPTH_MODEL` (or `DEPTH_VIDEO_MODEL`), falling
back to the first usable checkpoint if that one is gated off.

An unknown or unusable `model` fails on the job's **first tick** — the same place and the same
way an unavailable engine does, before any media is downloaded or decoded — and the error names
the valid ids. The engine never silently substitutes a different checkpoint: asking for Large
and quietly getting Small is a bug nobody can diagnose from the output.

### The `engine:model` shorthand

```
engine=depth-image:depth-anything-v2-large
```

Equivalent to sending `engine` and `model` separately. It exists for callers that only have one
field to spend: the MCP tools (`image_to_3d(engine=…)`) and the web client's single Engine
dropdown. When both are supplied the explicit `model` field wins. Engine names never contain a
colon, so the split is unambiguous.

### MCP

```python
image_to_3d(source=<memory ref>, engine="depth-image:depth-anything-v2-small")
media_to_3d(sources=[<video ref>], engine="depth-video")
list_engines()   # includes models[] and default_model
```

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `DEPTH_MODEL` | `depth-anything-v2-small` | Default checkpoint for `depth-image`. |
| `DEPTH_VIDEO_MODEL` | `depth-anything-v2-small` | Default checkpoint for `depth-video`. |
| `DEPTH_ALLOW_NONCOMMERCIAL` | `0` | Unlock CC-BY-NC / Apple-research weights. |
| `DEPTH_FOV_DEG` | `60` | Assumed horizontal FOV when the model cannot predict the real focal length. |
| `DEPTH_RANGE` | `8` | Far/near ratio the relative models are mapped onto. Higher = more parallax and more stretching at occlusion edges. |
| `DEPTH_MAX_POINTS` | `400000` | Gaussian budget; larger inputs are downsampled, not cropped. |
| `DEPTH_EDGE_DROP_PERCENT` | `2` | Share of the steepest-gradient pixels discarded (see below). |
| `DEPTH_VIDEO_FPS` | `2` | Frame sampling rate for `depth-video`. |
| `DEPTH_VIDEO_MAX_FRAMES` | `32` | Frames per clip, sampled evenly across its whole length. |
| `DEPTH_AUTO_ROUTE` | `0` | Let the depth engines join *automatic* routing (see below). |
| `VIDEO_DEPTH_CMD` | `video-depth-anything` | Binary for the external video-depth adapter. |
| `MODEL_WEIGHTS_DIR` | `/models` | Searched for cached HF snapshots before the ambient cache; used as `cache_dir` when it exists. |

## Routing

`DEPTH_AUTO_ROUTE` defaults to **off**, and the router's behaviour for jobs that do not name an
engine is byte-for-byte what it was before this feature existed. The depth engines are strictly
better than the flat Preview fallback and it was tempting to slot them in ahead
unconditionally — but their availability flips the moment a torch wheel lands in the image, and
"which engine processed my uploads" should not change because a dependency got installed.

Three ways to reach them:

1. `engine=depth-image` (or `depth-video`) per job — always works.
2. `DEFAULT_ENGINE=depth-image` — makes it the default for single images.
3. `DEPTH_AUTO_ROUTE=1` — `depth-image` becomes the single-image fallback ahead of `preview`,
   and `depth-video` becomes the video fallback when photogrammetry tooling is absent.

## Offline and air-gapped operation

Weights are fetched from HuggingFace on first use. To run with no network:

```bash
# on a connected machine
HF_HUB_CACHE=/models huggingface-cli download depth-anything/Depth-Anything-V2-Small-hf
# on the appliance
MODEL_WEIGHTS_DIR=/models HF_HUB_OFFLINE=1 uvicorn app.main:app
```

With downloads disabled, a checkpoint whose snapshot is not on disk reports
`available: false` and names the directory it looked in. `weights_cached` on each model entry
tells a UI whether picking it will trigger a download, and `approx_download_mb` how big it is.

## How the geometry works

All of it is pure numpy in `plywriter.py`, deliberately separate from the models so it can be
tested with no torch installed.

1. **Normalise.** Relative models (Depth Anything, MiDaS) emit *inverse* depth in arbitrary
   units. It is normalised against the 2nd/98th percentiles — a single blown-out sky pixel
   would otherwise compress the whole real scene into a sliver of the range — then **inverted**
   onto `[1, DEPTH_RANGE]`. Mapping it linearly instead is the tempting one-liner and it spends
   the depth budget on the background, turning faces into bas-relief. Metric models (Depth Pro)
   skip the inversion and are only rescaled and clipped, so the horizon at 10 km does not
   collapse everything else into a dot.
2. **Reject occlusion edges.** A monocular model has no idea what is behind the subject, so at
   every silhouette it interpolates. Back-projecting those pixels produces a curtain of
   Gaussians stretched between foreground and background — the single most recognisable
   artefact of naive depth splatting. The steepest `DEPTH_EDGE_DROP_PERCENT` of the log-depth
   gradient is discarded, leaving a clean silhouette with a hole behind it.
3. **Back-project.** Pinhole camera at the origin looking down -Z, +Y up, using the predicted
   focal length when there is one and `DEPTH_FOV_DEG` otherwise.
4. **Frame to match Preview.** The cloud is normalised so its median-depth plane lands exactly
   where the Preview engine puts its postcard. Switching a job from `preview` to `depth-image`
   reframes nothing in the viewer; the only difference is that the image now has depth.
5. **Size the Gaussians.** One splat covers one pixel's footprint, which grows linearly with
   depth. A constant radius leaves holes in the background and mush in the foreground.

### Video, specifically

Frames are sampled evenly across the whole clip (`DEPTH_VIDEO_FPS`, capped at
`DEPTH_VIDEO_MAX_FRAMES`), each is predicted, and then each frame's disparity is fitted onto the
previous one with a robust least-squares scale and shift.

Be precise about what that buys. Each frame's units are arbitrary, so normalising frames
independently makes the whole scene **breathe** — the dominant, immediately visible artefact.
The alignment removes that completely. It does **not** give true 4D consistency across a moving
camera; that is what the Video Depth Anything checkpoints are for.

The output is a **single** splat, not a sequence: the asset store models one master artifact per
asset and there is no Gaussian-sequence player in the viewer yet. The frame chosen is the
sharpest in the clip by variance-of-Laplacian, because hand-held video is mostly motion blur and
taking the middle frame gets a smeared one about half the time. When the inter-frame difference
shows the camera was static, the aligned depth of the whole window is median-fused into that
frame, which measurably denoises the prediction; when it was moving, fusing without optical flow
would smear rather than denoise, so it is skipped.

## Limitations

- **2.5D, not 3D.** One viewpoint. There is nothing behind the subject.
- **Video output is one frame.** No 4D/temporal splat asset — `EngineResult.temporal` stays
  `false` rather than claiming otherwise.
- **Chained temporal alignment drifts** over long clips, which is one reason
  `DEPTH_VIDEO_MAX_FRAMES` is 32.
- **The Video Depth Anything path is an adapter against an assumed CLI contract**
  (`--input --output --encoder`, a directory of `.npy` depth frames), in the same spirit as the
  TripoSplat adapter. It is covered by tests using a stand-in binary, not against a real build.
- **No mesh output.** Splats only.

## Testing

```bash
cd server && pytest -q
```

No GPU, no weights, no network. The neural network is the only mocked component: normalisation,
edge rejection, back-projection, temporal alignment, anchor-frame selection and PLY writing are
all the production code path.

- `tests/test_depth_geometry.py` — the maths, including that the output is *not* a flat plane
  and that it frames identically to Preview.
- `tests/test_depth_models.py` — the three availability gates (deps / licence / weights).
- `tests/test_depth_engines.py` — engine gating, model selection, routing, end-to-end runs for
  both engines, and the external-CLI adapter driven by a stub binary.
- `tests/test_depth_api.py` — the `/engines` payload keeps every pre-existing field.
