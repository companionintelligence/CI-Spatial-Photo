# Research: Image/Video → 3D engines & web viewers

_Compiled for the CI Photo Time Machine reimagining. Figures are drawn from official
project pages/READMEs and prior art as of mid‑2026. **Always re‑verify licenses before
commercial deployment** — several of these models look permissive but ship weights under
separate, more restrictive terms._

## TL;DR recommendation

| Concern | Decision |
| --- | --- |
| Default single‑image → 3D engine | **TripoSplat** (MIT code + weights, object‑centric 3DGS, tiny deps) |
| Optional single‑image *scene* engine | **Apple SHARP** (kept, but **non‑commercial research weights** — gated behind a flag) |
| Optional high‑fidelity mesh engine | **TRELLIS** (MIT) for mesh/asset; **Hunyuan3D 2.x** for PBR game meshes (Tencent license) |
| Multi‑image / static video → 3D | **COLMAP → gsplat / Brush** photogrammetry (Apache‑2.0/MIT); **VGGT** as a fast feed‑forward pose/geometry initializer |
| Web viewer | **Keep Spark** (`@sparkjsdev/spark`, Three.js, WebXR) for splats; add **`<model-viewer>`** for glTF meshes |
| Splat share format | Master `.ply` → deliver **`.spz`** (Niantic, ~10× smaller, open) and/or **`.sog`/SOGS** (PlayCanvas, image‑based, extreme compression) |
| Mesh share format | **`.glb`** (compact, PBR, `<model-viewer>` + AR Quick Look/Scene Viewer) |

The single most important finding: **the model that currently powers this repo (Apple
SHARP) is licensed for non‑commercial research only.** For a product that ships in the
Companion Intelligence marketplace, the default path must be an engine with commercially
usable weights. TripoSplat (MIT) is the natural default and, conveniently, already targets
the same Spark/SuperSplat viewers this app uses.

---

## 1. The two different "image → 3D" tasks

"Turn any image into 3D" is really two distinct problems. Getting the routing right matters
more than any single model choice.

1. **Object generation** — hallucinate a *complete* 3D object (including unseen back sides)
   from one photo. You can orbit 360°. Engines: TripoSplat, TRELLIS, Hunyuan3D, LGM/GRM,
   TripoSR/SF3D. Best for "make a shareable 3D asset from this thing."
2. **Scene view‑synthesis** — reconstruct the *visible* scene from a photo as splats you can
   look around with limited parallax. Best for the head‑tracked "magic portal" effect this
   app already ships. Engines: Apple SHARP, Flash3D, latentSplat.

The reimagined server classifies input and routes accordingly (see `ARCHITECTURE.md`), so we
support both rather than picking one.

---

## 2. Single‑image → 3D engines

### TripoSplat — **recommended default** (VAST‑AI‑Research / TripoAI)
- **Input:** single image. **Output:** `.ply` and `.splat` 3D Gaussians.
- **License:** **MIT** — code *and* model weights. Commercially usable.
- **Gaussians:** arbitrary count up to 262,144 (quality/perf trade‑off knob).
- **Deps:** minimal — `numpy`, `safetensors`, `pillow`, `tqdm`. No `transformers`, no
  `diffusers`, no version‑conflict hell. ~2,000 LOC across two files.
- **Container fit:** excellent — small image, weights from HuggingFace, official ComfyUI
  node exists but is not required.
- **Why default:** commercially clean license, object‑centric full‑3D output, tiny
  footprint, and it explicitly targets SparkJS / SuperSplat — the exact viewer stack here.
- Source: https://github.com/VAST-AI-Research/TripoSplat

### Apple SHARP — **kept as optional research/scene engine** (apple/ml-sharp)
- **Input:** single image (per‑image; a folder is processed image‑by‑image, no multi‑view
  fusion). **Output:** `.ply` 3DGS in OpenCV coords. Trajectory video render needs CUDA.
- **License:** code under Apple sample‑code terms; **weights under the Apple Machine
  Learning Research Model License = non‑commercial "Research Purposes" only** (see
  `LICENSE_MODEL`). Explicitly excludes "commercial exploitation, product development or use
  in any commercial product or service."
- **Strength:** genuinely excellent, sub‑second monocular *scene* synthesis — ideal for the
  parallax/portal effect. Runs on CPU/MPS/CUDA.
- **Verdict:** keep it, but gate behind `SHARP_ENABLE_RESEARCH=1` and never make it the
  product default. It is the wrong license posture for a shipped app.
- Source: https://github.com/apple/ml-sharp

### TRELLIS — optional high‑quality mesh/asset (microsoft/TRELLIS)
- **Input:** image or text. **Output:** unified **SLAT** decodes to 3DGS, radiance field, **or
  mesh (glb)**. **License:** MIT (code). Up to 2B params, trained on ~500K assets.
- **Cost:** heavy — practically wants ~16 GB VRAM. Best‑in‑class object quality.
- **Fit:** the "give me a clean game/AR‑ready mesh" path when the splat isn't enough.
- Source: https://github.com/microsoft/TRELLIS

### Hunyuan3D 2.x / 2.1 — optional PBR mesh (Tencent)
- **Input:** image. **Output:** high‑fidelity textured mesh with **PBR materials**.
- **License:** Tencent Hunyuan Community License — commercial use permitted *with
  restrictions* (notably excludes some regions and very‑large‑MAU deployments). **Verify.**
- **Fit:** production‑ready meshes for engines/AR; heavier than TripoSplat.

### Monocular depth → back‑projection — **shipped as `depth-image`**
The cheapest route to real parallax, and the only one on this page that runs usefully on a CPU
with no GPU at all. A depth model predicts one value per pixel; back‑projecting through a
pinhole camera yields a 2.5D Gaussian cloud. Nothing behind the subject, but within the ±20° the
XR portal uses it reads as a real 3D moment — and it is a category jump from the flat Preview
plane, which has no parallax whatsoever.

- **Depth Anything V2** (TikTok/HKU): the current quality/speed leader for relative depth.
  **Licence split matters**: Small is **Apache‑2.0**, Base and Large are **CC BY‑NC 4.0** — so
  Small is the product default and the larger two sit behind the same non‑commercial gate as
  SHARP.
- **MiDaS 3.0 / DPT** (Intel, **Apache‑2.0**): older and softer, fully permissive at every size.
  Worth keeping as a second opinion when Depth Anything hallucinates a plane.
- **Depth Pro** (Apple, non‑commercial research licence): predicts **metric** depth *and* the
  shot's focal length, which is the only way to get a geometrically correct back‑projection
  instead of an assumed 60° field of view. Same licence posture as SHARP.
- **Trade‑off vs. TripoSplat:** TripoSplat invents the unseen back of an object; depth
  estimation does not. Depth wins on scenes, speed and hardware; TripoSplat wins on objects.

### Faster/older baselines
- **TripoSR** (MIT) and **SF3D/Stable‑Fast‑3D** (Stability community license): fast single‑image
  → mesh; good low‑VRAM fallbacks.
- **LGM / GRM / Splatter Image**: multi/single‑view → 3DGS research models; mostly superseded
  by TripoSplat/TRELLIS for quality‑per‑effort.

---

## 3. Multi‑image & video → 3D

### Photogrammetry: COLMAP → gsplat / Brush — **recommended for multi‑image & static video**
- **COLMAP** (BSD): Structure‑from‑Motion to recover camera poses + sparse points.
- **gsplat** (Nerfstudio, **Apache‑2.0**): trains a 3D Gaussian scene from posed images. Already a
  dependency of this repo's SHARP renderer.
- **Brush** (Arthur Brussee, Apache‑2.0/MIT): Rust + `wgpu` splat trainer/viewer that runs
  cross‑platform *and in the browser via WASM* — attractive for a self‑hosted, GPU‑optional
  future.
- **Trade‑off:** robust and high quality, but minutes‑scale (SfM + optimization), needs enough
  overlapping views. This is the "real reconstruction" path vs. the "instant generation" path.

### Feed‑forward geometry (fast init / pose‑free): VGGT, DUSt3R/MASt3R, CUT3R, Fast3R
- **VGGT** (Meta + Oxford): single forward pass → cameras, depth, point maps from many views in
  seconds. Great to *replace/accelerate COLMAP* for pose init before gsplat. **Check weight
  license** (research‑leaning historically).
- **DUSt3R / MASt3R** (Naver): pose‑free dense stereo/geometry; **CC BY‑NC (non‑commercial)**.
- **CUT3R / Spann3R / Fast3R / MonST3R**: streaming/dynamic variants — mostly research licenses.
- **Verdict:** use a feed‑forward model *only* as an optional pose/geometry initializer with a
  license flag; keep COLMAP as the commercially clean default.

### Temporally consistent video depth — **shipped as `depth-video`**
The counterpart to `depth-image` for clips, and the answer for the video people actually have:
a few seconds of a mostly‑still phone, where photogrammetry has no inter‑frame parallax to work
with and fails outright.
- **Video Depth Anything** (Small **Apache‑2.0**, Large **CC BY‑NC 4.0**): a genuinely temporal
  network. Not on PyPI and does not load through `transformers`, so it is integrated as a
  subprocess adapter like TripoSplat rather than in‑process.
- **Per‑frame image depth + scale/shift alignment** — the default, because it needs no extra
  binary. Each frame's disparity is in arbitrary units, so normalising frames independently
  makes the scene *breathe*; fitting each frame onto its predecessor removes that entirely. It
  does **not** give true 4D consistency under a moving camera, which is precisely the gap the
  purpose‑built video checkpoints fill.
- **DepthCrafter / ChronoDepth**: stronger temporal priors, diffusion‑based, slow and
  research‑licensed. Not integrated.

### Dynamic / 4D (moving video): 4D Gaussian Splatting, Shape‑of‑Motion
- Time‑varying splats for motion‑heavy clips. Research‑grade, heavy. Out of scope for v1 but the
  asset schema reserves a `temporal` flag so 4D can slot in later. `depth-video` deliberately
  leaves that flag `false`: it emits one splat from the clip's sharpest frame, and claiming a 4D
  asset the viewer cannot play would be a lie in the metadata.

---

## 4. Web viewers

| Viewer | Stack | Formats | WebXR | License | Notes |
| --- | --- | --- | --- | --- | --- |
| **Spark** (`@sparkjsdev/spark`) — *current* | Three.js | `.ply` (incl. compressed), `.splat`, `.ksplat`, `.spz`, `.sog` | Yes | MIT | Modern, actively developed (World Labs), integrates with our Three.js scene + head‑tracking. **Keep.** See detail below. |
| mkkellogg/GaussianSplats3D | Three.js | `.ply`, `.splat`, `.ksplat` | Yes (VR) | MIT | Mature, battle‑tested; strong alternative if Spark stalls. |
| PlayCanvas **SuperSplat** | PlayCanvas | `.ply`, `.sog` export | Yes | MIT | Best‑in‑class *editor*; use for authoring/cleanup + `.sog` compression + hosted share pages. |
| PlayCanvas Engine | PlayCanvas | `.ply`, `.sog` | Yes | MIT | Full engine w/ GS + WebXR if we ever leave Three.js. |
| gsplat.js | WebGL | `.ply`, `.splat` | Limited | MIT | Minimal, easy to embed. |
| antimatter15/splat | WebGL | `.splat` | No | MIT | The original; great reference, minimal. |
| Babylon.js | Babylon/WebGPU | `.ply`, `.splat` | Yes | Apache‑2.0 | GS support built‑in; WebGPU path. |
| Google **`<model-viewer>`** | Three.js/WebGL | `.glb`, `.gltf` | Yes (AR Quick Look / Scene Viewer) | Apache‑2.0 | **Add this** for the mesh path — drop‑in web component with native mobile AR. |

### Spark in depth — the chosen splat renderer (sparkjsdev/spark)

- **What:** an advanced 3D Gaussian Splatting renderer for Three.js that renders splats *inside*
  the normal Three.js pipeline — splats and mesh objects coexist with correct depth sorting,
  which is exactly what the portal viewer (grid, future scene anchors) needs.
- **Maintainer/license:** built by **World Labs**; **MIT**. Latest release **v2.1.0** (May 2026).
- **Formats:** loads **`.ply` (incl. compressed), `.spz`, `.splat`, `.ksplat`, and `.sog`** —
  every format this server stores or delivers, including both compressed share formats.
- **Portability/perf:** targets **WebGL2 (~98%+ device support)** and is explicitly optimized to
  render fast on low‑powered mobile devices — important since share links land on phones.
- **Beyond static splats:** multiple simultaneous splat objects, real‑time color editing,
  displacement, skeletal animation, and a **dyno shader‑graph system** for GPU‑based splat
  creation/editing — headroom for the 4D/temporal roadmap and in‑viewer cleanup tools.
- **APIs we use:** `SparkRenderer`, `SplatMesh({ fileBytes, fileType })`, `SplatFileType` — see
  `web-server/client/src/components/SplatViewer.tsx` and `src/formats/*`.
- **Version note:** the client currently pins `@sparkjsdev/spark ^0.1.10`; upgrading to the 2.x
  line is a tracked follow‑up (verify `SplatMesh`/`SplatFileType` API surface, then bump).
- Source: https://github.com/sparkjsdev/spark • docs: https://sparkjs.dev

**Recommendation:** keep **Spark** for splats (it already backs the head‑tracked portal and
supports `.spz`), and add **`<model-viewer>`** for glTF meshes. One `SplatViewer` + one
`MeshViewer`, selected by asset `kind`. Both embed cleanly in the existing React app and
support a `/view/:assetId` share route.

---

## 5. On‑the‑wire formats for sharing

| Format | What | Size vs `.ply` | Use |
| --- | --- | --- | --- |
| `.ply` | Canonical 3DGS (full precision, SH) | 1× (large) | **Master** stored server‑side |
| `.splat` | antimatter15 packed (no SH) | ~0.25× | Legacy/simple delivery |
| `.ksplat` | mkkellogg compressed | ~0.3× | mkkellogg viewer |
| **`.spz`** | Niantic Gaussian format, open (MIT), keeps SH | **~0.1×** | **Preferred splat delivery** (Spark reads it) |
| **`.sog` / SOGS** | PlayCanvas image‑based (WebP) super‑compression | ~0.05–0.1× | Extreme compression for web/mobile sharing |
| **`.glb`** | Binary glTF mesh + PBR | n/a (mesh) | **Preferred mesh delivery**; native mobile AR |

**Strategy:** engines emit a master `.ply` (splats) or `.glb` (mesh); the server transcodes to
`.spz` (and optionally `.sog`) for delivery so shared links stay small and load fast on mobile.

---

## 5b. Blender‑based creation & editing (desktop authoring path)

Several splat workflows live inside Blender. They matter here as an **optional desktop
authoring/cleanup path** that complements the headless container — and as confirmation that our
recommended reconstruction stack (COLMAP → Brush) is the same one practitioners reach for.

| Tool | What it is | License | Relevance |
| --- | --- | --- | --- |
| **skysplat_blender** | Blender addon that runs the *full* pipeline: video (+SRT) → frame extraction → **COLMAP** SfM → **Brush** training → animated cameras → `.ply` | **MIT** (Brush Apache‑2.0) | Validates our headless `ffmpeg → COLMAP → Brush → .ply` photogrammetry engine; the container is the server‑side equivalent, Blender is the desktop equivalent. |
| **BlendSplat** (Gumroad) | Paid Blender addon for importing/working with Gaussian splats | Commercial (paid) | Reference for Blender‑side splat editing UX. |
| KIRI 3DGS Render Addon | Blender addon to render/visualize `.ply` splats | Proprietary/free | Where skysplat output is often viewed. |

**Takeaway:** the container ships the reconstruction pipeline headless (no Blender dependency);
users who want manual cleanup, camera animation, or compositing can round‑trip the same `.ply`
through Blender via skysplat_blender. We standardize on `.ply` precisely so this round‑trip works.
There is broad community interest in — but friction around — Blender GS workflows, which is
exactly the gap a one‑click containerized service fills.

### Reference indexes worth tracking
- **awesome‑3D‑gaussian‑splatting** (MrNeRF) — the canonical, continuously‑updated index of GS
  papers, code, viewers, and tools. Primary place to discover new engines/viewers as they land.
- **Awesome‑Gaussian‑Skills** (jaccen) — curated GS tooling/skills list.

## 6. Net recommendation for CI Photo Time Machine

1. **Default engine = TripoSplat** (MIT, object‑centric, tiny deps, Spark‑compatible).
2. **Keep SHARP** as an opt‑in, clearly labeled *research* engine for the monocular scene/portal
   effect — never the product default (license).
3. **Add a photogrammetry path** (COLMAP → gsplat/Brush) for multi‑image and static video, with
   VGGT as an optional fast pose initializer.
4. **Pluggable engine registry + input router** so new models (TRELLIS mesh, Hunyuan PBR, 4DGS)
   slot in without touching the API, viewer, or MCP surface.
5. **Viewer:** keep Spark, add `<model-viewer>`; deliver `.spz`/`.sog` for splats and `.glb` for
   meshes; share by `/view/:assetId`.

### Primary sources
- TripoSplat — https://github.com/VAST-AI-Research/TripoSplat
- Apple SHARP — https://github.com/apple/ml-sharp • model license: `LICENSE_MODEL` in this repo
- TRELLIS — https://github.com/microsoft/TRELLIS
- gsplat (Nerfstudio) — https://github.com/nerfstudio-project/gsplat
- Brush — https://github.com/ArthurBrussee/brush
- VGGT — https://github.com/facebookresearch/vggt
- Spark — https://github.com/sparkjsdev/spark • https://sparkjs.dev • mkkellogg — https://github.com/mkkellogg/GaussianSplats3D
- PlayCanvas SuperSplat — https://github.com/playcanvas/supersplat
- `<model-viewer>` — https://modelviewer.dev
- Niantic `.spz` — https://github.com/nianticlabs/spz • PlayCanvas SOGS — https://github.com/playcanvas/sogs
- skysplat_blender — https://github.com/kyjohnso/skysplat_blender • BlendSplat — https://soerensc.gumroad.com/l/BlendSplat
- awesome‑3D‑gaussian‑splatting — https://github.com/MrNeRF/awesome-3D-gaussian-splatting
- Awesome‑Gaussian‑Skills — https://github.com/jaccen/Awesome-Gaussian-Skills
