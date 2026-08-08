"""Depth-video engine — a clip -> temporally consistent depth -> a Gaussian cloud.

Photogrammetry (COLMAP + Brush) is the right answer when the camera *moves around* a subject,
but it needs parallax between frames, minutes of GPU time, and it fails outright on the video
people actually have: a few seconds of a mostly-still phone pointed at a moment. This engine
covers that case in seconds on CPU, and gives the clip's best frame real depth.

Two model families are selectable:

* **Video Depth Anything** (``video-depth-anything-small`` / ``-large``) — a genuinely temporal
  network. It is not on PyPI and does not load through ``transformers``, so it is wrapped as a
  subprocess adapter exactly like TripoSplat: absent binary means the model reports itself
  unavailable, never a crash.
* **Per-frame image checkpoints** (Depth Anything V2, MiDaS) — run frame by frame, then made
  consistent here by fitting each frame's disparity onto the previous one. This is the path that
  works out of the box with only the ``[depth]`` extra installed, and it is the default.

What the alignment does and does not fix is worth being precise about. Each frame's disparity
comes out in its own arbitrary units, so normalising frames independently makes the whole scene
*breathe* — the dominant, immediately visible artefact. Fitting a per-frame scale and shift
removes that entirely. It does **not** give true 4D consistency across a moving camera; that is
what the Video Depth Anything checkpoints are for.

Output is a single splat, not a 4D sequence: the asset store models one master artifact per
asset, and a viewer that can play a Gaussian sequence does not exist in this repo yet. The frame
chosen is the sharpest one in the clip (people hand-hold; half the frames are motion-blurred),
and when the camera turns out to have been static the aligned depth of the whole window is
median-fused into it, which measurably denoises the prediction.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from typing import Optional

import numpy as np

from ..config import Settings
from ..models import EngineCapabilities, EngineModelInfo, EngineResult, JobInput
from ..plywriter import depth_image_to_gaussian_ply
from . import depth_models as catalog
from .base import Engine, EngineError

VIDEO_DEPTH_CMD = os.environ.get("VIDEO_DEPTH_CMD", "video-depth-anything")

MODELS = catalog.VIDEO_MODELS

# Below this mean absolute inter-frame luma difference (on [0,1] normalised grey), the camera is
# treated as static and the depth window is fused. Chosen well under the difference a hand-held
# pan produces and well over sensor noise on a tripod shot.
STATIC_CAMERA_THRESHOLD = 0.02


# ── pure-numpy sequence maths (no torch, no weights — unit-tested directly) ────────────────

def frame_sharpness(gray: np.ndarray) -> float:
    """Variance of the Laplacian: the standard cheap focus measure.

    Used to pick which frame of the clip becomes the splat. Hand-held video is mostly motion
    blur; taking the middle frame gets a smeared one about half the time, and blur turns into
    mush in the reconstruction because the depth head has no edges to key on.
    """
    g = np.asarray(gray, dtype=np.float32)
    if g.ndim != 2 or min(g.shape) < 3:
        return 0.0
    lap = (
        -4.0 * g[1:-1, 1:-1] + g[:-2, 1:-1] + g[2:, 1:-1] + g[1:-1, :-2] + g[1:-1, 2:]
    )
    return float(lap.var())


def fit_scale_shift(source: np.ndarray, target: np.ndarray) -> tuple[float, float]:
    """Least-squares (a, b) minimising ``|a*source + b - target|``, fit on trimmed inliers.

    Trimming matters: sky and specular highlights pin the extremes of a disparity map and are
    exactly where the model is least stable frame to frame, so an untrimmed fit lets a handful
    of pixels drag the scale for the whole frame. Only samples inside both maps' 2nd..98th
    percentiles vote.
    """
    s = np.asarray(source, dtype=np.float64).ravel()
    t = np.asarray(target, dtype=np.float64).ravel()
    if s.size != t.size or s.size == 0:
        raise ValueError("source and target must be the same non-empty shape")
    finite = np.isfinite(s) & np.isfinite(t)
    if finite.sum() < 16:
        return 1.0, 0.0
    s_lo, s_hi = np.percentile(s[finite], (2.0, 98.0))
    t_lo, t_hi = np.percentile(t[finite], (2.0, 98.0))
    mask = finite & (s >= s_lo) & (s <= s_hi) & (t >= t_lo) & (t <= t_hi)
    if mask.sum() < 16:
        mask = finite
    sv, tv = s[mask], t[mask]
    var = float(sv.var())
    if var < 1e-12:
        # Constant source: no scale is recoverable, match the means and keep going rather than
        # dividing by zero and poisoning the rest of the sequence with NaNs.
        return 1.0, float(tv.mean() - sv.mean())
    a = float(((sv - sv.mean()) * (tv - tv.mean())).mean() / var)
    b = float(tv.mean() - a * sv.mean())
    return a, b


def align_sequence(frames: list[np.ndarray]) -> list[np.ndarray]:
    """Bring every frame's disparity into the first frame's units.

    Chained: frame i is fitted onto the already-aligned frame i-1, because the content overlap
    that the fit relies on is between *neighbours*. Chaining accumulates drift over long clips,
    which is one more reason ``DEPTH_VIDEO_MAX_FRAMES`` defaults to 32.
    """
    if not frames:
        return []
    aligned = [np.asarray(frames[0], dtype=np.float32)]
    for frame in frames[1:]:
        a, b = fit_scale_shift(frame, aligned[-1])
        aligned.append((np.asarray(frame, dtype=np.float32) * a + b).astype(np.float32))
    return aligned


def camera_is_static(grays: list[np.ndarray], threshold: float = STATIC_CAMERA_THRESHOLD) -> bool:
    """Whether consecutive frames are near-identical, i.e. fusing them is meaningful.

    There is no optical flow here, so fusing a *moving* camera's frames would average depth
    across pixels that no longer look at the same thing — smearing, not denoising. The median
    (not mean) of the inter-frame differences is used so one blink or one passing car does not
    veto fusion for an otherwise tripod-steady clip.
    """
    if len(grays) < 2:
        return False
    diffs = [
        float(np.abs(np.asarray(b, dtype=np.float32) - np.asarray(a, dtype=np.float32)).mean())
        for a, b in zip(grays, grays[1:])
    ]
    return float(np.median(diffs)) < threshold


def sample_evenly(items: list[Path], limit: int) -> list[Path]:
    """Take at most ``limit`` items spread across the whole list.

    Truncating to the first N instead would reconstruct the first second of a 30-second clip and
    silently ignore the rest — including, usually, the part the user cared about.
    """
    if limit <= 0 or len(items) <= limit:
        return items
    idx = np.linspace(0, len(items) - 1, limit).round().astype(int)
    return [items[i] for i in sorted(set(idx.tolist()))]


class DepthVideoEngine(Engine):
    name = "depth-video"

    # ── availability ──────────────────────────────────────────────────────────
    def _cli(self) -> Optional[str]:
        return shutil.which(VIDEO_DEPTH_CMD)

    def _model_availability(self, spec, settings: Settings) -> tuple[bool, Optional[str]]:
        """Catalog gating plus the one thing the catalog cannot know: is the CLI installed."""
        available, reason = catalog.availability(spec, settings)
        if available and spec.loader == "external-cli" and not self._cli():
            return False, (
                f"Video Depth Anything CLI ('{VIDEO_DEPTH_CMD}') not found. Install it in the "
                "engine image (GPU recommended) or set VIDEO_DEPTH_CMD, or pick a per-frame "
                "model such as 'depth-anything-v2-small'."
            )
        return available, reason

    def is_available(self, settings: Settings) -> tuple[bool, Optional[str]]:
        if not shutil.which("ffmpeg"):
            return False, "Video depth needs ffmpeg in the image to decode frames."
        reasons = {m.id: self._model_availability(m, settings)[1] for m in MODELS}
        if all(r is not None for r in reasons.values()):
            return False, (
                catalog.primary_reason(reasons, settings.depth_video_model)
                or "No video depth checkpoint is usable."
            )
        return True, None

    def available_models(self, settings: Settings) -> list[EngineModelInfo]:
        infos: list[EngineModelInfo] = []
        for spec in MODELS:
            info = catalog.describe(spec, settings)
            available, reason = self._model_availability(spec, settings)
            info.available = available
            info.unavailable_reason = reason
            infos.append(info)
        return infos

    def _resolve_spec(self, requested: Optional[str], settings: Settings):
        """Takes the requested id, NOT a JobInput.

        `capabilities()` has to answer "which checkpoint would a job with no
        `model` field run?" and there is no JobInput at that point. Threading
        the raw id through is what lets the advertised default and the executed
        default come out of one function instead of two that drift.
        """
        spec = catalog.resolve(
            requested,
            MODELS,
            settings.depth_video_model,
            settings,
            engine_name=self.name,
        )
        # catalog.resolve cannot see the CLI, so re-check the binary for the model it landed on.
        available, reason = self._model_availability(spec, settings)
        if not available:
            if requested:
                raise EngineError(reason or f"Model '{spec.id}' is unavailable.")
            usable = next(
                (m for m in MODELS if self._model_availability(m, settings)[0]), None
            )
            if usable is None:
                raise EngineError(reason or "No video depth checkpoint is usable.")
            return usable
        return spec

    def resolve_model(self, job_input: JobInput, settings: Settings) -> Optional[str]:
        return self._resolve_spec(job_input.requested_model, settings).id

    def default_model_id(self, settings: Settings) -> Optional[str]:
        """The checkpoint a job that names no model would actually get.

        Deliberately the SAME call `resolve_model()` makes, with `requested=None`
        — not a re-derivation. The previous "first entry in catalog order whose
        `available` is true" disagreed with it under stock settings on any box
        with the Video Depth Anything CLI installed: VIDEO_MODELS lists the CLI
        checkpoints first, so /engines advertised `video-depth-anything-small`
        (temporal, GPU) while a job with no `model` ran `depth-anything-v2-small`
        (per-frame, CPU) — i.e. the field promised the engine's whole selling
        point and delivered the fallback. The client believes this field: it
        prints that checkpoint's licence and GPU need in the Create panel.
        """
        try:
            return self._resolve_spec(None, settings).id
        except EngineError:
            # Nothing usable at all. `available` is already False with a reason;
            # a null default is the honest answer rather than naming a
            # checkpoint that cannot run.
            return None

    def capabilities(self, settings: Settings) -> EngineCapabilities:
        available, reason = self.is_available(settings)
        models = self.available_models(settings)
        default = self.default_model_id(settings)
        return EngineCapabilities(
            name=self.name,
            description="Video -> temporally consistent depth -> Gaussian cloud of the clip's "
            "sharpest frame. Seconds on CPU, unlike photogrammetry. Choose the checkpoint with "
            "the 'model' field.",
            inputs=["video"],
            intents=["auto", "scene"],
            output_kind="splat",
            output_formats=["ply"],
            commercial=True,
            requires_gpu=False,
            license="Per-model — see models[].license (Apache-2.0 for the defaults)",
            available=available,
            unavailable_reason=reason,
            models=models,
            default_model=default,
        )

    def can_handle(self, job_input: JobInput, settings: Settings) -> bool:
        return job_input.source_type == "video" and len(job_input.files) >= 1

    # ── frame handling ────────────────────────────────────────────────────────
    def _extract_frames(self, video: Path, frames_dir: Path, settings: Settings) -> list[Path]:
        ffmpeg = self.require_binary("ffmpeg")
        frames_dir.mkdir(parents=True, exist_ok=True)
        cmd = [
            ffmpeg, "-nostdin", "-i", str(video),
            "-qscale:v", "2", "-vf", f"fps={settings.depth_video_fps}",
            str(frames_dir / "frame_%05d.jpg"),
        ]
        try:
            subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=1800)
        except subprocess.CalledProcessError as e:
            raise EngineError(f"ffmpeg could not decode the video: {e.stderr or e.stdout}") from e
        except subprocess.TimeoutExpired as e:
            raise EngineError("ffmpeg timed out extracting frames.") from e
        frames = sorted(frames_dir.glob("frame_*.jpg"))
        if not frames:
            raise EngineError("No frames could be extracted from the video.")
        return sample_evenly(frames, settings.depth_video_max_frames)

    def _cli_depths(self, video: Path, spec, workdir: Path, frame_count: int) -> list[np.ndarray]:
        """Run the Video Depth Anything CLI and read back one depth map per extracted frame.

        Adapter contract, mirroring how ``triposplat.py`` treats its runtime: the binary is
        expected to accept ``--input VIDEO --output DIR --encoder {vits,vitl}`` and to write a
        sorted sequence of ``.npy`` depth frames (or a single ``.npz``) into DIR. Adjust here if
        the installed build differs.
        """
        runtime = self._cli()
        if not runtime:
            raise EngineError(f"Video Depth Anything CLI ('{VIDEO_DEPTH_CMD}') not found.")
        out_dir = workdir / "vda_out"
        out_dir.mkdir(parents=True, exist_ok=True)
        cmd = [runtime, "--input", str(video), "--output", str(out_dir),
               "--encoder", spec.cli_encoder]
        try:
            subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=7200)
        except subprocess.CalledProcessError as e:
            raise EngineError(f"Video Depth Anything failed: {e.stderr or e.stdout}") from e
        except subprocess.TimeoutExpired as e:
            raise EngineError("Video Depth Anything timed out.") from e

        npys = sorted(out_dir.glob("*.npy"))
        if npys:
            depths = [np.load(p).astype(np.float32) for p in npys]
        else:
            npzs = sorted(out_dir.glob("*.npz"))
            if not npzs:
                raise EngineError(
                    f"Video Depth Anything wrote no .npy/.npz depth frames into {out_dir}."
                )
            bundle = np.load(npzs[0])
            key = next((k for k in ("depth", "depths", "arr_0") if k in bundle), None)
            if key is None:
                raise EngineError(f"Unrecognised depth archive keys: {list(bundle.keys())}.")
            depths = [np.asarray(d, dtype=np.float32) for d in bundle[key]]

        if not depths:
            raise EngineError("Video Depth Anything produced an empty depth sequence.")
        # The CLI runs at the video's own frame rate while we sampled at DEPTH_VIDEO_FPS, so the
        # two sequences cover the same span at different densities. Map proportionally rather
        # than requiring equal counts, which no real build would satisfy.
        idx = np.linspace(0, len(depths) - 1, frame_count).round().astype(int)
        return [depths[i] for i in idx]

    # ── execution ─────────────────────────────────────────────────────────────
    def run(self, job_input: JobInput, workdir: Path, settings: Settings) -> EngineResult:
        available, reason = self.is_available(settings)
        if not available:
            raise EngineError(reason or "Video depth engine unavailable")
        if not job_input.files:
            raise EngineError("Video depth engine needs a video file.")

        # Lazy, for the same reason as depth_image.run: the registry instantiates engines at
        # import time and this pulls torch in transitively.
        from PIL import Image

        from .depth_backend import DepthPrediction, predict_depth, to_working_depth

        spec = self._resolve_spec(job_input.requested_model, settings)
        video = Path(job_input.files[0])
        frames = self._extract_frames(video, workdir / "frames", settings)

        images = [Image.open(p).convert("RGB") for p in frames]
        grays = [
            np.asarray(im.convert("L").resize((64, 64)), dtype=np.float32) / 255.0 for im in images
        ]

        if spec.loader == "external-cli":
            raw = self._cli_depths(video, spec, workdir, len(frames))
            # The CLI's own output resolution need not match the frames we decoded.
            raw = [_resize_to(d, images[i].size) for i, d in enumerate(raw)]
        else:
            raw = [predict_depth(im, spec, settings).values for im in images]

        # Run for both paths. For the per-frame models this is what makes the sequence usable at
        # all; for Video Depth Anything it is close to a no-op (scale ~1, shift ~0) and exists as
        # insurance against a build that normalises its output per frame on the way out.
        aligned = align_sequence(raw)

        anchor = max(range(len(grays)), key=lambda i: frame_sharpness(grays[i]))
        if camera_is_static(grays):
            # Static camera: every frame looks at the same pixel, so the per-pixel median across
            # the aligned window is a strictly better estimate than any single frame's.
            depth_raw = np.median(np.stack(aligned, axis=0), axis=0).astype(np.float32)
        else:
            depth_raw = aligned[anchor]

        out = workdir / "master.ply"
        try:
            depth = to_working_depth(
                DepthPrediction(values=depth_raw, kind=spec.kind, focal_px=None), settings
            )
            count = depth_image_to_gaussian_ply(
                frames[anchor],
                depth,
                out,
                fov_deg=settings.depth_fov_deg,
                max_points=settings.depth_max_points,
                edge_drop_percent=settings.depth_edge_drop_percent,
            )
        except ValueError as e:
            raise EngineError(f"Depth sequence from '{spec.id}' was unusable: {e}") from e
        if count == 0:
            raise EngineError(f"Depth sequence from '{spec.id}' produced no points.")

        thumb = self.make_thumbnail(frames[anchor], workdir)
        return EngineResult(kind="splat", master_path=out, master_format="ply", thumbnail_path=thumb)


def _resize_to(depth: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """Resample a depth frame to ``(width, height)``, NEAREST to preserve occlusion edges."""
    from PIL import Image

    arr = np.asarray(np.squeeze(depth), dtype=np.float32)
    if arr.shape[1::-1] == size:
        return arr
    return np.asarray(Image.fromarray(arr, mode="F").resize(size, Image.NEAREST), dtype=np.float32)
