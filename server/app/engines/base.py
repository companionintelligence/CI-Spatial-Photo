"""Engine protocol shared by every 3D backend.

An engine turns localized media (files on disk) into an :class:`EngineResult`. The job
manager owns classification, persistence, transcoding, and memory — engines only do the
model work. Adding a new engine = subclass :class:`Engine` and register it in ``registry``.
"""

from __future__ import annotations

import shutil
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional

from PIL import Image

from ..config import Settings
from ..models import EngineCapabilities, EngineResult, JobInput


class EngineError(RuntimeError):
    """Raised when an engine cannot run (missing GPU/weights/tooling or bad input)."""


class Engine(ABC):
    name: str = "engine"

    @abstractmethod
    def capabilities(self, settings: Settings) -> EngineCapabilities: ...

    def is_available(self, settings: Settings) -> tuple[bool, Optional[str]]:
        """Return (available, reason_if_not). Default: always available."""
        return True, None

    @abstractmethod
    def can_handle(self, job_input: JobInput, settings: Settings) -> bool:
        """Whether this engine can process the given input at all."""

    @abstractmethod
    def run(self, job_input: JobInput, workdir: Path, settings: Settings) -> EngineResult:
        """Produce a 3D asset. Runs in a worker thread; may block. Raise EngineError on failure."""

    # ── helpers for subclasses ─────────────────────────────────────────────────
    @staticmethod
    def make_thumbnail(source_image: Path, workdir: Path, size: int = 512) -> Optional[Path]:
        try:
            img = Image.open(source_image).convert("RGB")
            img.thumbnail((size, size), Image.LANCZOS)
            out = workdir / "thumb.webp"
            img.save(out, "WEBP", quality=82)
            return out
        except Exception:
            return None

    @staticmethod
    def require_binary(name: str) -> str:
        path = shutil.which(name)
        if not path:
            raise EngineError(f"Required tool '{name}' is not installed in this container.")
        return path
