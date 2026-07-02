"""Preview engine — CPU-only, always available.

Turns a single image into a real, viewable 3DGS ``.ply`` (a flat, textured plane of
Gaussians). Not a reconstruction of unseen geometry, but it makes the full create -> explore
loop work with zero GPU and zero downloaded weights, so anyone can try the app immediately.
Use TripoSplat / SHARP / photogrammetry for true 3D.
"""

from __future__ import annotations

from pathlib import Path

from ..config import Settings
from ..models import EngineCapabilities, EngineResult, JobInput
from ..plywriter import image_to_flat_gaussian_ply
from .base import Engine, EngineError


class PreviewEngine(Engine):
    name = "preview"

    def capabilities(self, settings: Settings) -> EngineCapabilities:
        return EngineCapabilities(
            name=self.name,
            description="CPU-only instant preview: image -> flat textured Gaussian plane. "
            "No GPU or weights required. Great for trying the pipeline; low fidelity.",
            inputs=["image"],
            intents=["auto", "scene"],
            output_kind="splat",
            output_formats=["ply"],
            commercial=True,
            requires_gpu=False,
            license="MIT (this project)",
            available=True,
        )

    def can_handle(self, job_input: JobInput, settings: Settings) -> bool:
        return job_input.source_type == "image" and len(job_input.files) >= 1

    def run(self, job_input: JobInput, workdir: Path, settings: Settings) -> EngineResult:
        if not job_input.files:
            raise EngineError("Preview engine needs one image.")
        src = job_input.files[0]
        out = workdir / "master.ply"
        image_to_flat_gaussian_ply(src, out)
        thumb = self.make_thumbnail(src, workdir)
        return EngineResult(kind="splat", master_path=out, master_format="ply", thumbnail_path=thumb)
