"""Apple SHARP engine — optional, research-gated monocular scene synthesis.

SHARP (https://github.com/apple/ml-sharp) produces excellent sub-second monocular *scene*
splats — ideal for the head-tracked "magic portal" effect. But its weights are licensed for
**non-commercial research only** (see LICENSE_MODEL), so it is disabled unless
``SHARP_ENABLE_RESEARCH=1`` and must never be the product default.

Wraps the bundled ``sharp predict`` CLI from the parent project.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Optional

from ..config import Settings
from ..models import EngineCapabilities, EngineResult, JobInput
from .base import Engine, EngineError


class SharpEngine(Engine):
    name = "sharp"

    def is_available(self, settings: Settings) -> tuple[bool, Optional[str]]:
        if not settings.sharp_enable_research:
            return False, (
                "SHARP is disabled. Its weights are non-commercial research only; set "
                "SHARP_ENABLE_RESEARCH=1 to enable for research use."
            )
        if not shutil.which("sharp"):
            return False, "SHARP CLI ('sharp') not found. Install the bundled sharp package."
        return True, None

    def capabilities(self, settings: Settings) -> EngineCapabilities:
        available, reason = self.is_available(settings)
        return EngineCapabilities(
            name=self.name,
            description="Single image -> monocular scene Gaussians (great for the XR portal). "
            "Research use only.",
            inputs=["image"],
            intents=["scene"],
            output_kind="splat",
            output_formats=["ply"],
            commercial=False,
            requires_gpu=False,  # CPU/MPS/CUDA; CUDA only needed for video render
            license="Apple ML Research Model License (non-commercial)",
            available=available,
            unavailable_reason=reason,
        )

    def can_handle(self, job_input: JobInput, settings: Settings) -> bool:
        if not settings.sharp_enable_research:
            return False
        return job_input.source_type == "image" and len(job_input.files) >= 1

    def run(self, job_input: JobInput, workdir: Path, settings: Settings) -> EngineResult:
        available, reason = self.is_available(settings)
        if not available:
            raise EngineError(reason or "SHARP unavailable")
        if not job_input.files:
            raise EngineError("SHARP needs one image.")

        src = job_input.files[0]
        out_dir = workdir / "sharp_out"
        out_dir.mkdir(parents=True, exist_ok=True)
        cmd = ["sharp", "predict", "-i", str(src), "-o", str(out_dir), "--device", "default"]
        try:
            subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=1800)
        except subprocess.CalledProcessError as e:
            raise EngineError(f"SHARP failed: {e.stderr or e.stdout}") from e
        except subprocess.TimeoutExpired as e:
            raise EngineError("SHARP timed out.") from e

        plys = list(out_dir.glob("*.ply"))
        if not plys:
            raise EngineError("SHARP produced no PLY.")
        master = workdir / "master.ply"
        shutil.copy2(plys[0], master)
        thumb = self.make_thumbnail(src, workdir)
        return EngineResult(kind="splat", master_path=master, master_format="ply", thumbnail_path=thumb)
