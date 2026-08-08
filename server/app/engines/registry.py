"""Engine registry + input router.

The router classifies a :class:`JobInput` and picks the best available engine, falling back to
the always-available CPU Preview engine so a single image can *always* become a viewable splat.

Engines that wrap several interchangeable checkpoints (the two depth backends) take the choice
from ``JobInput.requested_model``. The router also accepts it fused into the engine name as
``"<engine>:<model>"`` — see :func:`split_engine_ref` for why that shorthand exists.
"""

from __future__ import annotations

from typing import Optional

from ..config import Settings
from ..models import EngineCapabilities, JobInput
from .base import Engine, EngineError
from .depth_image import DepthImageEngine
from .depth_video import DepthVideoEngine
from .photogrammetry import PhotogrammetryEngine
from .preview import PreviewEngine
from .sharp import SharpEngine
from .triposplat import TripoSplatEngine


def split_engine_ref(ref: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    """Split ``"depth-image:depth-anything-v2-large"`` into ``("depth-image", "depth-…-large")``.

    Model choice has its own field (`model` on POST /jobs, `JobInput.requested_model`) and that
    is the documented way to use it. This shorthand exists because two callers only have an
    engine string to give: the MCP tools, whose signatures live in a file this feature does not
    own, and the web client's single Engine dropdown. Without it, neither could reach any model
    but the default, which would make "the user picks the model" false for every agent-driven
    job. Engine names in this registry never contain a colon, so the split is unambiguous.
    """
    if not ref or ":" not in ref:
        return ref, None
    name, _, model = ref.partition(":")
    return (name.strip() or None), (model.strip() or None)


class EngineRegistry:
    def __init__(self) -> None:
        self._engines: dict[str, Engine] = {}
        for engine in (
            PreviewEngine(),
            TripoSplatEngine(),
            SharpEngine(),
            PhotogrammetryEngine(),
            DepthImageEngine(),
            DepthVideoEngine(),
        ):
            self._engines[engine.name] = engine

    def get(self, name: str) -> Engine | None:
        return self._engines.get(name)

    def capabilities(self, settings: Settings) -> list[EngineCapabilities]:
        return [e.capabilities(settings) for e in self._engines.values()]

    def _available(self, engine: Engine, settings: Settings) -> bool:
        return engine.is_available(settings)[0]

    def route(self, job_input: JobInput, settings: Settings) -> Engine:
        """Pick an engine for this input. Raises EngineError if nothing can handle it.

        Mutates ``job_input`` in one narrow way: an ``"<engine>:<model>"`` request is normalised
        into ``requested_engine`` + ``requested_model`` so every engine downstream sees a plain
        name. The job manager passes the same object to ``engine.run``, so the split has to
        happen on the object rather than on a copy.
        """
        name, inline_model = split_engine_ref(job_input.requested_engine)
        if inline_model:
            job_input.requested_engine = name
            # An explicit `model=` field wins over the shorthand; a caller that sends both means
            # the field, and silently preferring the string glued to the engine name would be a
            # very hard bug to see.
            job_input.requested_model = job_input.requested_model or inline_model

        engine = self._route(job_input, settings)
        # Validate the model here, on the job's very first tick and right next to "unknown
        # engine", rather than leaving it to engine.run() — which happens after the media has
        # been pulled from Companion memory and (for video) decoded into frames. A typo in a
        # model id should not cost a download.
        engine.resolve_model(job_input, settings)
        return engine

    def _route(self, job_input: JobInput, settings: Settings) -> Engine:
        # 1) Explicit request wins (fail loudly if it can't be honored).
        if job_input.requested_engine:
            engine = self.get(job_input.requested_engine)
            if not engine:
                raise EngineError(f"Unknown engine '{job_input.requested_engine}'.")
            available, reason = engine.is_available(settings)
            if not available:
                raise EngineError(reason or f"Engine '{engine.name}' is unavailable.")
            if not engine.can_handle(job_input, settings):
                raise EngineError(
                    f"Engine '{engine.name}' cannot handle input type '{job_input.source_type}'."
                )
            return engine

        # 2) Multi-image / video -> photogrammetry, then (video only) the depth-video engine.
        if job_input.source_type in ("images", "video"):
            photo = self._engines["photogrammetry"]
            if self._available(photo, settings) and photo.can_handle(job_input, settings):
                return photo
            fallback = self._depth_fallback("depth-video", job_input, settings)
            if fallback:
                return fallback
            raise EngineError(photo.is_available(settings)[1] or "No engine for multi-image/video.")

        # 3) Single image: honor intent, prefer configured default, else fall back.
        if job_input.intent == "scene":
            sharp = self._engines["sharp"]
            if self._available(sharp, settings) and sharp.can_handle(job_input, settings):
                return sharp

        default = self.get(settings.default_engine)
        if default and self._available(default, settings) and default.can_handle(job_input, settings):
            return default

        fallback = self._depth_fallback("depth-image", job_input, settings)
        if fallback:
            return fallback

        preview = self._engines["preview"]
        if preview.can_handle(job_input, settings):
            return preview

        raise EngineError("No engine available for this input.")

    def _depth_fallback(self, name: str, job_input: JobInput, settings: Settings) -> Engine | None:
        """A depth engine, but only if the operator asked for it in automatic routing.

        ``DEPTH_AUTO_ROUTE`` defaults off on purpose. depth-image is strictly better than the
        flat Preview plane and it is tempting to slot it in ahead unconditionally — but its
        availability flips the moment a torch wheel lands in the image, and "which engine
        processed my uploads" is not something that should change because a dependency got
        installed. Setting ``DEFAULT_ENGINE=depth-image`` (step 3 above) or passing ``engine=``
        per job reaches these engines regardless of this flag.
        """
        if not settings.depth_auto_route and settings.default_engine != name:
            return None
        engine = self.get(name)
        if engine and self._available(engine, settings) and engine.can_handle(job_input, settings):
            return engine
        return None


_registry: EngineRegistry | None = None


def get_registry() -> EngineRegistry:
    global _registry
    if _registry is None:
        _registry = EngineRegistry()
    return _registry
