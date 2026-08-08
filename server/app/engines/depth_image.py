"""Depth-image engine — one photo -> monocular depth -> a back-projected Gaussian cloud.

This is the CPU-viable step up from the Preview engine. Preview lays the photo on a flat plane:
correct colours, zero geometry, and the illusion collapses the instant the viewer's head moves.
This engine predicts a per-pixel depth map, back-projects it through a pinhole camera and writes
the result as 3D Gaussians, so the foreground genuinely occludes the background as you lean.
It is still a single viewpoint — there is nothing behind the subject — but it is real parallax,
and on the small Depth Anything V2 checkpoint it runs on a laptop CPU in a few seconds.

Six checkpoints are selectable (Depth Anything V2 S/B/L, MiDaS DPT Hybrid/Large, Apple Depth
Pro); see ``depth_models.py`` for the catalog and why they are one engine rather than six
registry entries. Everything heavy is imported lazily inside :meth:`run`.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from ..config import Settings
from ..models import EngineCapabilities, EngineModelInfo, EngineResult, JobInput
from ..plywriter import depth_image_to_gaussian_ply
from . import depth_models as catalog
from .base import Engine, EngineError

# Kept as a tuple so the ordering in the API payload is the ordering a UI should offer:
# permissive + fast first, research-licensed + heavy last.
MODELS = catalog.IMAGE_MODELS


class DepthImageEngine(Engine):
    name = "depth-image"

    # ── availability ──────────────────────────────────────────────────────────
    def is_available(self, settings: Settings) -> tuple[bool, Optional[str]]:
        """Available when *any* catalogued checkpoint is usable.

        Deliberately not "all of them": with ``DEPTH_ALLOW_NONCOMMERCIAL=0`` the Base/Large and
        Depth Pro entries are gated off by licence and always will be, so requiring every model
        would report the engine broken on a correctly configured server. The per-model reasons
        in ``capabilities().models`` carry the detail.
        """
        missing = catalog.missing_python_deps()
        if missing:
            return False, (
                "Depth estimation needs " + " + ".join(missing) + ". Install the optional extra: "
                "pip install 'ci-photo-time-machine-server[depth]' (CPU works; GPU is faster)."
            )
        reasons = {m.id: catalog.availability(m, settings)[1] for m in MODELS}
        if all(r is not None for r in reasons.values()):
            return False, (
                catalog.primary_reason(reasons, settings.depth_model)
                or "No depth checkpoint is usable."
            )
        return True, None

    def available_models(self, settings: Settings) -> list[EngineModelInfo]:
        return [catalog.describe(m, settings) for m in MODELS]

    def resolve_model(self, job_input: JobInput, settings: Settings) -> Optional[str]:
        return catalog.resolve(
            job_input.requested_model, MODELS, settings.depth_model, settings, engine_name=self.name
        ).id

    def default_model_id(self, settings: Settings) -> Optional[str]:
        """The checkpoint a job that names no model would actually get.

        The SAME `catalog.resolve` call `resolve_model()` makes, with no
        request — not a second derivation of "the default". The previous
        version took the first catalog entry whose `available` was true, which
        ignores `settings.depth_model` entirely: with
        `DEPTH_MODEL=depth-anything-v2-large` and non-commercial weights
        enabled, /engines advertised `depth-anything-v2-small` (Apache-2.0,
        CPU, ~100 MB) for a job that would pull 1.34 GB of CC-BY-NC weights and
        want a GPU. The client prints the advertised checkpoint's licence in
        the Create panel, so that is a licence claim, not just a label.
        """
        try:
            return catalog.resolve(
                None, MODELS, settings.depth_model, settings, engine_name=self.name
            ).id
        except EngineError:
            # Nothing usable. `available` already carries the reason; naming a
            # checkpoint that cannot run would be worse than naming none.
            return None

    def capabilities(self, settings: Settings) -> EngineCapabilities:
        available, reason = self.is_available(settings)
        models = self.available_models(settings)
        default = self.default_model_id(settings)
        return EngineCapabilities(
            name=self.name,
            description="Single image -> monocular depth -> back-projected Gaussian cloud. Real "
            "parallax from one photo, no GPU required with the small model. Choose the "
            "checkpoint with the 'model' field.",
            inputs=["image"],
            intents=["auto", "scene"],
            output_kind="splat",
            output_formats=["ply"],
            # The engine ships nothing non-commercial itself; individual checkpoints do, and say
            # so per-model. With the default settings only Apache-2.0 weights can run.
            commercial=True,
            requires_gpu=False,
            license="Per-model — see models[].license (Apache-2.0 for the defaults)",
            available=available,
            unavailable_reason=reason,
            models=models,
            default_model=default,
        )

    def can_handle(self, job_input: JobInput, settings: Settings) -> bool:
        return job_input.source_type == "image" and len(job_input.files) >= 1

    # ── execution ─────────────────────────────────────────────────────────────
    def run(self, job_input: JobInput, workdir: Path, settings: Settings) -> EngineResult:
        available, reason = self.is_available(settings)
        if not available:
            raise EngineError(reason or "Depth engine unavailable")
        if not job_input.files:
            raise EngineError("Depth engine needs one image.")

        # Imported here, not at module scope: `registry.py` builds every engine at import time,
        # and this module pulls in torch transitively.
        from PIL import Image

        from .depth_backend import predict_depth, to_working_depth

        spec = catalog.resolve(
            job_input.requested_model, MODELS, settings.depth_model, settings, engine_name=self.name
        )
        src = Path(job_input.files[0])
        try:
            image = Image.open(src)
        except Exception as e:  # noqa: BLE001
            raise EngineError(f"Could not read image '{src.name}': {e}") from e

        prediction = predict_depth(image, spec, settings)

        out = workdir / "master.ply"
        try:
            depth = to_working_depth(prediction, settings)
            count = depth_image_to_gaussian_ply(
                src,
                depth,
                out,
                fov_deg=settings.depth_fov_deg,
                focal_px=prediction.focal_px,
                max_points=settings.depth_max_points,
                edge_drop_percent=settings.depth_edge_drop_percent,
            )
        except ValueError as e:
            # Covers both normalisation and back-projection: reached when the prediction is
            # degenerate (all-NaN, all-zero, or every pixel rejected as an edge). A bare
            # ValueError out of numpy reaches the user as "internal error: ..." via the job
            # manager's catch-all; name the model and the input instead.
            raise EngineError(f"Depth map from '{spec.id}' was unusable: {e}") from e
        if count == 0:
            raise EngineError(f"Depth map from '{spec.id}' produced no points.")

        thumb = self.make_thumbnail(src, workdir)
        return EngineResult(kind="splat", master_path=out, master_format="ply", thumbnail_path=thumb)
