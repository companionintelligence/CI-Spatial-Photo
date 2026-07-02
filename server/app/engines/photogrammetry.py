"""Photogrammetry engine — multi-image and video -> 3D Gaussian scene.

Implements the same headless pipeline that skysplat_blender orchestrates inside Blender:

    video/images -> (ffmpeg frame extraction) -> COLMAP SfM (poses) -> Brush/gsplat training -> .ply

All components are commercially usable (COLMAP BSD, Brush Apache-2.0, gsplat Apache-2.0). This
is the "real reconstruction" path (minutes, GPU) as opposed to instant single-image generation.
Requires the tools to be present in the image; otherwise reports unavailable with guidance.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from typing import Optional

from ..config import Settings
from ..models import EngineCapabilities, EngineResult, JobInput
from .base import Engine, EngineError

BRUSH_CMD = os.environ.get("BRUSH_CMD", "brush")


class PhotogrammetryEngine(Engine):
    name = "photogrammetry"

    def _missing(self) -> list[str]:
        missing = []
        if not shutil.which("colmap"):
            missing.append("colmap")
        if not (shutil.which(BRUSH_CMD) or shutil.which("ns-train")):
            missing.append("brush/gsplat")
        return missing

    def is_available(self, settings: Settings) -> tuple[bool, Optional[str]]:
        missing = self._missing()
        if missing:
            return False, (
                "Photogrammetry needs "
                + ", ".join(missing)
                + " in the image. Install COLMAP + Brush (or Nerfstudio gsplat), GPU recommended."
            )
        return True, None

    def capabilities(self, settings: Settings) -> EngineCapabilities:
        available, reason = self.is_available(settings)
        return EngineCapabilities(
            name=self.name,
            description="Multiple images or a video -> reconstructed Gaussian scene "
            "(COLMAP poses + Brush/gsplat training).",
            inputs=["images", "video"],
            intents=["auto", "scene"],
            output_kind="splat",
            output_formats=["ply"],
            commercial=True,
            requires_gpu=True,
            license="COLMAP BSD + Brush/gsplat Apache-2.0",
            available=available,
            unavailable_reason=reason,
        )

    def can_handle(self, job_input: JobInput, settings: Settings) -> bool:
        return job_input.source_type in ("images", "video")

    def _extract_frames(self, video: Path, frames_dir: Path, fps: float = 2.0) -> None:
        ffmpeg = self.require_binary("ffmpeg")
        frames_dir.mkdir(parents=True, exist_ok=True)
        cmd = [ffmpeg, "-i", str(video), "-qscale:v", "2", "-vf", f"fps={fps}",
               str(frames_dir / "frame_%05d.jpg")]
        subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=1800)

    def run(self, job_input: JobInput, workdir: Path, settings: Settings) -> EngineResult:
        available, reason = self.is_available(settings)
        if not available:
            raise EngineError(reason or "Photogrammetry unavailable")

        frames_dir = workdir / "frames"
        if job_input.source_type == "video":
            if not job_input.files:
                raise EngineError("Video reconstruction needs a video file.")
            self._extract_frames(job_input.files[0], frames_dir)
        else:
            frames_dir.mkdir(parents=True, exist_ok=True)
            for f in job_input.files:
                shutil.copy2(f, frames_dir / Path(f).name)

        n = len(list(frames_dir.glob("*")))
        if n < 3:
            raise EngineError(f"Need at least 3 frames for reconstruction; got {n}.")

        # COLMAP SfM + Brush/gsplat training are invoked here. The exact commands depend on the
        # installed builds; the engine image is expected to provide a `ptm-reconstruct` wrapper
        # that runs COLMAP -> Brush and writes `master.ply`. This keeps the API image slim.
        wrapper = shutil.which("ptm-reconstruct")
        out = workdir / "master.ply"
        if wrapper:
            cmd = [wrapper, "--frames", str(frames_dir), "--output", str(out)]
            try:
                subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=7200)
            except subprocess.CalledProcessError as e:
                raise EngineError(f"Reconstruction failed: {e.stderr or e.stdout}") from e
        else:
            raise EngineError(
                "Reconstruction wrapper 'ptm-reconstruct' (COLMAP->Brush) not found in image."
            )
        if not out.exists():
            raise EngineError("Reconstruction produced no PLY.")

        thumb = self.make_thumbnail(next(frames_dir.glob("*")), workdir)
        return EngineResult(kind="splat", master_path=out, master_format="ply", thumbnail_path=thumb)
