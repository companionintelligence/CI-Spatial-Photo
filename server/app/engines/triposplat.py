"""TripoSplat engine — the default high-fidelity single-image -> 3DGS backend.

TripoSplat (https://github.com/VAST-AI-Research/TripoSplat) is MIT-licensed for both code and
weights, object-centric, and outputs .ply/.splat that our Spark viewer reads directly.

Integration is via a subprocess to a configurable command (default ``triposplat``) so the
heavy ML deps live in the engine's own environment/image and are not imported by the API.
When the runtime or weights are absent the engine reports itself unavailable and raises a
clear error rather than failing cryptically.
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

TRIPOSPLAT_CMD = os.environ.get("TRIPOSPLAT_CMD", "triposplat")


class TripoSplatEngine(Engine):
    name = "triposplat"

    def _runtime(self) -> Optional[str]:
        return shutil.which(TRIPOSPLAT_CMD)

    def is_available(self, settings: Settings) -> tuple[bool, Optional[str]]:
        if not self._runtime():
            return False, (
                f"TripoSplat CLI ('{TRIPOSPLAT_CMD}') not found. Install TripoSplat and its "
                "weights in the engine image (GPU recommended)."
            )
        return True, None

    def capabilities(self, settings: Settings) -> EngineCapabilities:
        available, reason = self.is_available(settings)
        return EngineCapabilities(
            name=self.name,
            description="Single image -> object-centric 3D Gaussians (up to 262k), MIT-licensed.",
            inputs=["image"],
            intents=["auto", "object"],
            output_kind="splat",
            output_formats=["ply", "splat"],
            commercial=True,
            requires_gpu=True,
            license="MIT (code + weights)",
            available=available,
            unavailable_reason=reason,
        )

    def can_handle(self, job_input: JobInput, settings: Settings) -> bool:
        return job_input.source_type == "image" and len(job_input.files) >= 1

    def run(self, job_input: JobInput, workdir: Path, settings: Settings) -> EngineResult:
        runtime = self._runtime()
        if not runtime:
            raise EngineError(self.is_available(settings)[1] or "TripoSplat unavailable")
        if not job_input.files:
            raise EngineError("TripoSplat needs one image.")

        src = job_input.files[0]
        out = workdir / "master.ply"
        # Expected CLI contract: `triposplat --image IN --output OUT.ply`. Adjust the adapter
        # if the installed TripoSplat build exposes a different interface.
        cmd = [runtime, "--image", str(src), "--output", str(out)]
        try:
            subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=1800)
        except subprocess.CalledProcessError as e:
            raise EngineError(f"TripoSplat failed: {e.stderr or e.stdout}") from e
        except subprocess.TimeoutExpired as e:
            raise EngineError("TripoSplat timed out.") from e
        if not out.exists():
            raise EngineError("TripoSplat produced no output PLY.")

        thumb = self.make_thumbnail(src, workdir)
        return EngineResult(kind="splat", master_path=out, master_format="ply", thumbnail_path=thumb)
