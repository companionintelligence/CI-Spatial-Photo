"""Engine registry + input router.

The router classifies a :class:`JobInput` and picks the best available engine, falling back to
the always-available CPU Preview engine so a single image can *always* become a viewable splat.
"""

from __future__ import annotations

from ..config import Settings
from ..models import EngineCapabilities, JobInput
from .base import Engine, EngineError
from .photogrammetry import PhotogrammetryEngine
from .preview import PreviewEngine
from .sharp import SharpEngine
from .triposplat import TripoSplatEngine


class EngineRegistry:
    def __init__(self) -> None:
        self._engines: dict[str, Engine] = {}
        for engine in (PreviewEngine(), TripoSplatEngine(), SharpEngine(), PhotogrammetryEngine()):
            self._engines[engine.name] = engine

    def get(self, name: str) -> Engine | None:
        return self._engines.get(name)

    def capabilities(self, settings: Settings) -> list[EngineCapabilities]:
        return [e.capabilities(settings) for e in self._engines.values()]

    def _available(self, engine: Engine, settings: Settings) -> bool:
        return engine.is_available(settings)[0]

    def route(self, job_input: JobInput, settings: Settings) -> Engine:
        """Pick an engine for this input. Raises EngineError if nothing can handle it."""
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

        # 2) Multi-image / video -> photogrammetry.
        if job_input.source_type in ("images", "video"):
            photo = self._engines["photogrammetry"]
            if self._available(photo, settings) and photo.can_handle(job_input, settings):
                return photo
            raise EngineError(photo.is_available(settings)[1] or "No engine for multi-image/video.")

        # 3) Single image: honor intent, prefer configured default, else fall back to preview.
        if job_input.intent == "scene":
            sharp = self._engines["sharp"]
            if self._available(sharp, settings) and sharp.can_handle(job_input, settings):
                return sharp

        default = self.get(settings.default_engine)
        if default and self._available(default, settings) and default.can_handle(job_input, settings):
            return default

        preview = self._engines["preview"]
        if preview.can_handle(job_input, settings):
            return preview

        raise EngineError("No engine available for this input.")


_registry: EngineRegistry | None = None


def get_registry() -> EngineRegistry:
    global _registry
    if _registry is None:
        _registry = EngineRegistry()
    return _registry
