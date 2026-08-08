"""Catalog of the depth checkpoints the two depth engines can run, and the gating that
decides whether any given one is usable *right now*.

This module is deliberately import-cheap: nothing here imports torch, transformers, or
huggingface_hub. ``registry.py`` instantiates every engine at import time and the FastAPI app
builds its engine list during startup, so a single top-level ``import torch`` in this dependency
chain would turn "optional GPU extra not installed" into "the API will not boot". Availability is
therefore answered with :func:`importlib.util.find_spec` (which locates a module without
executing it) and with plain filesystem checks against the HuggingFace cache layout.

Three independent things can make a checkpoint unusable, and the UI needs to tell them apart
because the fix is different in each case:

1. **The Python extra is missing** — ``pip install '.[depth]'``. Affects every model at once.
2. **The licence gate is closed** — Depth Anything V2 Base/Large, Video Depth Anything Large and
   Depth Pro ship CC-BY-NC / Apple-research weights. This repo already refuses to run
   non-commercial weights implicitly (see ``SHARP_ENABLE_RESEARCH``), so they need
   ``DEPTH_ALLOW_NONCOMMERCIAL=1``. Affects only the models so licensed.
3. **The weights are not on disk and we cannot fetch them** — an air-gapped box, or
   ``HF_HUB_OFFLINE=1``. Affects only the models that are not cached.

Cases 2 and 3 are per-model, which is exactly why ``EngineCapabilities`` grew a ``models`` list
instead of the engines being split into one registry entry per checkpoint: a single boolean on
the engine cannot say "small works, large needs a 1.3 GB download you have not done yet".
"""

from __future__ import annotations

import importlib.util
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Optional

from ..config import Settings
from ..models import EngineModelInfo
from .base import EngineError

Loader = Literal["transformers", "external-cli"]
DepthKind = Literal["relative", "metric"]

# The Python distributions the in-process (transformers) loader needs. Kept as (import name,
# pip name) pairs because the two differ often enough to make a naive message wrong.
#
# torchvision is not optional despite never being imported by this project: from transformers 5
# onward `AutoImageProcessor` hard-requires it, and without it the failure arrives from deep
# inside `from_pretrained` as "requires the Torchvision library" *after* the engine has already
# reported itself available and a job has been accepted. Probing for it here turns that into an
# up-front "install the extra" on `GET /engines`.
_TRANSFORMERS_DEPS: tuple[tuple[str, str], ...] = (
    ("torch", "torch"),
    ("torchvision", "torchvision"),
    ("transformers", "transformers"),
)


@dataclass(frozen=True)
class DepthModelSpec:
    """One selectable checkpoint.

    ``kind`` drives the maths downstream and is not cosmetic. Relative models (Depth Anything,
    MiDaS/DPT) emit *inverse* depth in arbitrary units — larger means nearer — and must be
    inverted and range-mapped before back-projection. Metric models (Depth Pro) emit metres and
    must not be, or the scene turns inside out.
    """

    id: str
    label: str
    description: str
    loader: Loader
    kind: DepthKind
    license: str
    commercial: bool
    approx_download_mb: int
    hf_repo: str = ""            # transformers loader only
    cli_encoder: str = ""        # external-cli loader only: --encoder value
    temporal: bool = False       # true = the checkpoint itself is temporally consistent
    prefers_gpu: bool = True


# ── Image checkpoints ─────────────────────────────────────────────────────────────────────
# Sizes are the fp32 download of the *-hf conversions, rounded; they exist so a client can warn
# before committing a user on a hotel connection to a 1.3 GB pull.

DEPTH_ANYTHING_V2_SMALL = DepthModelSpec(
    id="depth-anything-v2-small",
    label="Depth Anything V2 — Small",
    description="24M-parameter ViT-S. Runs in a couple of seconds on CPU and is the only "
    "Depth Anything V2 checkpoint under a permissive licence, so it is the default.",
    loader="transformers",
    kind="relative",
    license="Apache-2.0",
    commercial=True,
    approx_download_mb=100,
    hf_repo="depth-anything/Depth-Anything-V2-Small-hf",
    prefers_gpu=False,
)

DEPTH_ANYTHING_V2_BASE = DepthModelSpec(
    id="depth-anything-v2-base",
    label="Depth Anything V2 — Base",
    description="97M-parameter ViT-B. Noticeably cleaner object boundaries than Small.",
    loader="transformers",
    kind="relative",
    license="CC-BY-NC-4.0 (weights)",
    commercial=False,
    approx_download_mb=390,
    hf_repo="depth-anything/Depth-Anything-V2-Base-hf",
)

DEPTH_ANYTHING_V2_LARGE = DepthModelSpec(
    id="depth-anything-v2-large",
    label="Depth Anything V2 — Large",
    description="335M-parameter ViT-L. Best relative-depth detail available here; wants a GPU.",
    loader="transformers",
    kind="relative",
    license="CC-BY-NC-4.0 (weights)",
    commercial=False,
    approx_download_mb=1340,
    hf_repo="depth-anything/Depth-Anything-V2-Large-hf",
)

MIDAS_DPT_HYBRID = DepthModelSpec(
    id="midas-dpt-hybrid",
    label="MiDaS 3.0 — DPT Hybrid",
    description="Intel's DPT-Hybrid MiDaS. Older and softer than Depth Anything, but Apache-2.0 "
    "and a useful second opinion when Depth Anything hallucinates a plane.",
    loader="transformers",
    kind="relative",
    license="Apache-2.0",
    commercial=True,
    approx_download_mb=490,
    hf_repo="Intel/dpt-hybrid-midas",
)

MIDAS_DPT_LARGE = DepthModelSpec(
    id="midas-dpt-large",
    label="MiDaS 3.0 — DPT Large",
    description="Intel's DPT-Large MiDaS. Same family as DPT Hybrid, more capacity.",
    loader="transformers",
    kind="relative",
    license="Apache-2.0",
    commercial=True,
    approx_download_mb=1370,
    hf_repo="Intel/dpt-large",
)

DEPTH_PRO = DepthModelSpec(
    id="depth-pro",
    label="Apple Depth Pro",
    description="Predicts depth in metres *and* the focal length of the shot. The only model "
    "here that gives a true pinhole back-projection instead of an assumed 60-degree field of "
    "view, so straight lines stay straight and the parallax is geometrically correct.",
    loader="transformers",
    kind="metric",
    license="Apple ML Research Model License (non-commercial)",
    commercial=False,
    approx_download_mb=1900,
    hf_repo="apple/DepthPro-hf",
)

IMAGE_MODELS: tuple[DepthModelSpec, ...] = (
    DEPTH_ANYTHING_V2_SMALL,
    DEPTH_ANYTHING_V2_BASE,
    DEPTH_ANYTHING_V2_LARGE,
    MIDAS_DPT_HYBRID,
    MIDAS_DPT_LARGE,
    DEPTH_PRO,
)

# ── Video checkpoints ─────────────────────────────────────────────────────────────────────
# Video Depth Anything is not packaged on PyPI and does not load through `transformers`, so it
# is wrapped as a subprocess adapter exactly like TripoSplat. The per-frame image models are
# also offered for video: paired with the scale/shift alignment in `depth_video.py` they give a
# usable, flicker-free result with no extra install, which matters because the CLI is not
# something most deployments will have.

VIDEO_DEPTH_ANYTHING_SMALL = DepthModelSpec(
    id="video-depth-anything-small",
    label="Video Depth Anything — Small",
    description="Purpose-built temporally consistent video depth (ViT-S). Needs the "
    "video-depth-anything CLI in the engine image; see VIDEO_DEPTH_CMD.",
    loader="external-cli",
    kind="relative",
    license="Apache-2.0",
    commercial=True,
    approx_download_mb=110,
    cli_encoder="vits",
    temporal=True,
)

VIDEO_DEPTH_ANYTHING_LARGE = DepthModelSpec(
    id="video-depth-anything-large",
    label="Video Depth Anything — Large",
    description="Temporally consistent video depth (ViT-L). Best quality, GPU only, "
    "non-commercial weights.",
    loader="external-cli",
    kind="relative",
    license="CC-BY-NC-4.0 (weights)",
    commercial=False,
    approx_download_mb=1400,
    cli_encoder="vitl",
    temporal=True,
)

VIDEO_MODELS: tuple[DepthModelSpec, ...] = (
    VIDEO_DEPTH_ANYTHING_SMALL,
    VIDEO_DEPTH_ANYTHING_LARGE,
    # Per-frame fallbacks. Same checkpoints as the image engine; temporal consistency is
    # recovered afterwards by fitting each frame's disparity onto the running reference.
    DEPTH_ANYTHING_V2_SMALL,
    DEPTH_ANYTHING_V2_BASE,
    DEPTH_ANYTHING_V2_LARGE,
    MIDAS_DPT_HYBRID,
    MIDAS_DPT_LARGE,
)

BY_ID: dict[str, DepthModelSpec] = {m.id: m for m in (*IMAGE_MODELS, *VIDEO_MODELS)}


# ── Dependency / weight probing ───────────────────────────────────────────────────────────

def missing_python_deps() -> list[str]:
    """pip names of the depth extra's imports that are not importable.

    ``find_spec`` only locates the module, it does not execute it — which is the whole point.
    It can also raise (ValueError on a half-uninstalled distribution whose ``__spec__`` is None,
    ModuleNotFoundError when a parent package is absent), and an exception here would propagate
    out of ``GET /api/v1/engines``; treat any failure as "not importable".
    """
    missing: list[str] = []
    for import_name, pip_name in _TRANSFORMERS_DEPS:
        try:
            found = importlib.util.find_spec(import_name) is not None
        except (ImportError, ValueError):
            found = False
        if not found:
            missing.append(pip_name)
    return missing


def downloads_disabled() -> bool:
    """Whether we are forbidden from reaching the Hub for weights we do not already have."""
    return any(
        os.environ.get(var, "").strip().lower() in ("1", "true", "yes", "on")
        for var in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "PTM_NO_DOWNLOAD")
    )


def cache_roots(settings: Settings) -> list[Path]:
    """Directories that may hold a HuggingFace snapshot, most specific first.

    ``MODEL_WEIGHTS_DIR`` is the mount this project already documents for engine weights, so it
    is preferred over the ambient HF cache; a deployment that bind-mounts read-only weights into
    the container gets them found without also having to set HF_HOME.
    """
    roots: list[Path] = []
    if settings.model_weights_dir:
        roots.append(Path(settings.model_weights_dir))
    env_cache = os.environ.get("HF_HUB_CACHE") or os.environ.get("TRANSFORMERS_CACHE")
    if env_cache:
        roots.append(Path(env_cache))
    hf_home = os.environ.get("HF_HOME")
    roots.append(Path(hf_home) / "hub" if hf_home else Path.home() / ".cache" / "huggingface" / "hub")
    return roots


def weights_cached(spec: DepthModelSpec, settings: Settings) -> bool:
    """Whether a usable local snapshot of ``spec`` exists under any cache root.

    Mirrors ``huggingface_hub``'s on-disk layout (``models--org--name/snapshots/<rev>/…``)
    rather than importing it, because ``huggingface_hub`` is part of the optional extra and this
    has to answer correctly on a box where the extra was never installed.
    """
    if spec.loader != "transformers" or not spec.hf_repo:
        return False
    folder = "models--" + spec.hf_repo.replace("/", "--")
    for root in cache_roots(settings):
        snapshots = root / folder / "snapshots"
        try:
            if snapshots.is_dir() and any(rev.is_dir() and any(rev.iterdir()) for rev in snapshots.iterdir()):
                return True
        except OSError:
            continue
    return False


def availability(spec: DepthModelSpec, settings: Settings) -> tuple[bool, Optional[str]]:
    """(usable now, reason if not) for one checkpoint. Reasons name the exact fix."""
    if not spec.commercial and not settings.depth_allow_noncommercial:
        return False, (
            f"'{spec.id}' weights are {spec.license} and this server refuses non-commercial "
            "weights by default. Set DEPTH_ALLOW_NONCOMMERCIAL=1 to enable them for research use."
        )

    if spec.loader == "external-cli":
        # Resolved by the engine that owns the binary; it knows the env var name.
        return True, None

    missing = missing_python_deps()
    if missing:
        return False, (
            "Depth estimation needs " + " + ".join(missing) + ". Install the optional extra: "
            "pip install 'ci-photo-time-machine-server[depth]' (CPU works; GPU is faster)."
        )
    if not weights_cached(spec, settings) and downloads_disabled():
        return False, (
            f"Weights for '{spec.id}' ({spec.hf_repo}, ~{spec.approx_download_mb} MB) are not in "
            f"the local cache and downloads are disabled. Pre-fetch them into "
            f"{settings.model_weights_dir} or unset HF_HUB_OFFLINE/PTM_NO_DOWNLOAD."
        )
    return True, None


def primary_reason(reasons: dict[str, Optional[str]], preferred_id: str) -> Optional[str]:
    """Of several per-model failures, the one to show as *the* engine's reason.

    Iteration order is catalog order, and catalog order puts a CLI-only model first — so a naive
    ``next(r for r in reasons)`` tells a user with no torch installed to go install a Video Depth
    Anything binary, which is not their problem. Prefer whatever blocks the *configured default*
    model, since that is the one a job with no explicit choice would have run.
    """
    preferred = reasons.get(preferred_id)
    if preferred:
        return preferred
    return next((r for r in reasons.values() if r), None)


def describe(spec: DepthModelSpec, settings: Settings) -> EngineModelInfo:
    """Render one catalog entry as the API payload the engine list carries."""
    available, reason = availability(spec, settings)
    return EngineModelInfo(
        id=spec.id,
        label=spec.label,
        description=spec.description,
        license=spec.license,
        commercial=spec.commercial,
        requires_gpu=spec.prefers_gpu,
        temporal=spec.temporal,
        approx_download_mb=spec.approx_download_mb,
        weights_cached=weights_cached(spec, settings),
        available=available,
        unavailable_reason=reason,
    )


def resolve(
    requested: Optional[str],
    allowed: tuple[DepthModelSpec, ...],
    default_id: str,
    settings: Settings,
    *,
    engine_name: str,
) -> DepthModelSpec:
    """Pick the checkpoint for a job: the request, else the configured default, else the first
    permissively-licensed entry.

    Raises :class:`EngineError` rather than silently substituting. Falling back to a different
    model than the one asked for is the kind of "helpfulness" that produces a bug report six
    months later about why the large model looks exactly like the small one.
    """
    by_id = {m.id: m for m in allowed}
    if requested:
        spec = by_id.get(requested)
        if spec is None:
            known = ", ".join(sorted(by_id))
            raise EngineError(
                f"Unknown model '{requested}' for engine '{engine_name}'. Available: {known}."
            )
        available, reason = availability(spec, settings)
        if not available:
            raise EngineError(reason or f"Model '{requested}' is unavailable.")
        return spec

    # No explicit request: honour the configured default if it is usable, otherwise fall through
    # to the first usable entry so a licence gate does not hard-fail a job that never named a
    # model in the first place.
    candidates = [by_id[default_id]] if default_id in by_id else []
    candidates += [m for m in allowed if m.id != default_id]
    first_reason: Optional[str] = None
    for spec in candidates:
        available, reason = availability(spec, settings)
        if available:
            return spec
        first_reason = first_reason or reason
    raise EngineError(first_reason or f"No depth model is available for engine '{engine_name}'.")
