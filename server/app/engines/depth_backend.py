"""Lazy torch/transformers plumbing shared by the two depth engines.

**Nothing at module scope may import torch or transformers.** ``registry.py`` constructs every
engine when ``app.main`` is imported, so an eager import here would make the whole API refuse to
start on a machine without the optional ``[depth]`` extra — the exact failure the TripoSplat and
SHARP engines are shaped to avoid. Every heavy import in this file lives inside a function body.

The other job this module does is *caching*. A 32-frame video job calls the predictor 32 times;
re-running ``from_pretrained`` each time would re-read (and, first time, re-download) hundreds of
megabytes per frame and dominate the runtime. Loaded models are therefore kept in a
process-global dict behind a lock, since engines run on worker threads via ``asyncio.to_thread``.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import numpy as np
from PIL import Image

from ..config import Settings
from ..plywriter import disparity_to_depth, normalize_metric_depth
from .base import EngineError
from .depth_models import DepthModelSpec, downloads_disabled, missing_python_deps

_MODEL_CACHE: dict[tuple[str, str], tuple[Any, Any]] = {}
_CACHE_LOCK = threading.Lock()


@dataclass
class DepthPrediction:
    """Raw model output plus the metadata needed to interpret it.

    ``values`` is disparity for relative models and metres for metric ones — see
    :attr:`DepthModelSpec.kind`. Keeping them un-normalised here lets the video engine align a
    whole sequence *before* anything is range-mapped, which is the only order that works: map
    each frame independently and the working volume breathes from frame to frame.
    """

    values: np.ndarray
    kind: str
    focal_px: Optional[float] = None


def select_device() -> str:
    """Best available torch device. Imports torch — call only from inside ``run()``."""
    import torch

    if torch.cuda.is_available():
        return "cuda"
    # Apple silicon. Worth having: the small Depth Anything checkpoint on MPS is roughly an
    # order of magnitude faster than CPU, which is the difference between a demo and a wait.
    if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _cache_dir(settings: Settings) -> Optional[str]:
    """Where transformers should look for / put weights.

    Only returned when the directory already exists. ``MODEL_WEIGHTS_DIR`` defaults to ``/models``
    — a path that exists in the container and does not on a laptop — and handing transformers a
    non-existent absolute path makes it try to create it and fail with a permission error that
    reads nothing like "you have no weights".
    """
    root = Path(settings.model_weights_dir) if settings.model_weights_dir else None
    return str(root) if root and root.is_dir() else None


def _load(spec: DepthModelSpec, settings: Settings) -> tuple[Any, Any]:
    """Return a cached (processor, model) pair for ``spec``, loading it on first use."""
    missing = missing_python_deps()
    if missing:
        raise EngineError(
            "Depth estimation needs " + " + ".join(missing) + ". Install the optional extra: "
            "pip install 'ci-photo-time-machine-server[depth]'."
        )

    from transformers import AutoImageProcessor, AutoModelForDepthEstimation

    device = select_device()
    key = (spec.hf_repo, device)
    with _CACHE_LOCK:
        cached = _MODEL_CACHE.get(key)
    if cached is not None:
        return cached

    kwargs: dict[str, Any] = {"local_files_only": downloads_disabled()}
    cache_dir = _cache_dir(settings)
    if cache_dir:
        kwargs["cache_dir"] = cache_dir

    try:
        processor = AutoImageProcessor.from_pretrained(spec.hf_repo, **kwargs)
        model = AutoModelForDepthEstimation.from_pretrained(spec.hf_repo, **kwargs)
    except Exception as e:  # noqa: BLE001 — network, auth, disk and version errors all land here
        raise EngineError(
            f"Could not load depth model '{spec.id}' ({spec.hf_repo}, "
            f"~{spec.approx_download_mb} MB): {e}. Check network access, or pre-fetch the "
            f"weights into MODEL_WEIGHTS_DIR and set HF_HUB_OFFLINE=1."
        ) from e

    model = model.to(device)
    model.eval()
    # float32 everywhere. fp16 halves VRAM but a depth head's output feeds straight into a
    # percentile normalisation, and fp16 overflow in the sky region silently flattens the
    # foreground — not worth the memory on a job that runs once.
    with _CACHE_LOCK:
        _MODEL_CACHE[key] = (processor, model)
    return processor, model


def predict_depth(image: Image.Image, spec: DepthModelSpec, settings: Settings) -> DepthPrediction:
    """Run one image through ``spec`` and return its raw depth/disparity at full resolution."""
    if spec.loader != "transformers":
        raise EngineError(f"Model '{spec.id}' is not an in-process transformers checkpoint.")

    import torch

    processor, model = _load(spec, settings)
    rgb = image.convert("RGB")
    w, h = rgb.size

    try:
        inputs = processor(images=rgb, return_tensors="pt")
        # Not every value a processor returns is a tensor — Depth Pro's returns image sizes as
        # plain lists — and calling .to() on those raises an AttributeError that reads like a
        # broken model rather than a shape of data we did not expect.
        inputs = {
            k: (v.to(model.device) if hasattr(v, "to") else v) for k, v in inputs.items()
        }
        with torch.no_grad():
            outputs = model(**inputs)
    except Exception as e:  # noqa: BLE001
        raise EngineError(f"Depth inference with '{spec.id}' failed: {e}") from e

    focal_px: Optional[float] = None
    tensor = None
    # Newer transformers exposes post_process_depth_estimation, which resizes to the source
    # resolution and, for Depth Pro, also returns the predicted focal length. It does not exist
    # on every processor in every version, so fall back to a plain interpolate.
    post = getattr(processor, "post_process_depth_estimation", None)
    if callable(post):
        try:
            result = post(outputs, target_sizes=[(h, w)])[0]
            tensor = result.get("predicted_depth")
            focal_px = _as_float(result.get("focal_length"))
        except Exception:  # noqa: BLE001 — signature drift across versions; the fallback is fine
            tensor = None

    if tensor is None:
        raw = outputs.predicted_depth
        if raw.ndim == 3:
            raw = raw.unsqueeze(1)
        tensor = torch.nn.functional.interpolate(
            raw, size=(h, w), mode="bicubic", align_corners=False
        )[0, 0]

    values = tensor.detach().to("cpu").float().numpy()
    return DepthPrediction(values=np.squeeze(values), kind=spec.kind, focal_px=focal_px)


def _as_float(value: Any) -> Optional[float]:
    """Coerce a scalar that may be a python number, a 0-d tensor or a 1-element tensor."""
    if value is None:
        return None
    try:
        if hasattr(value, "item"):
            return float(value.reshape(-1)[0].item() if hasattr(value, "reshape") else value.item())
        return float(value)
    except Exception:  # noqa: BLE001
        return None


def to_working_depth(prediction: DepthPrediction, settings: Settings) -> np.ndarray:
    """Turn a raw prediction into the ``[1, DEPTH_RANGE]`` volume the back-projector expects."""
    if prediction.kind == "metric":
        return normalize_metric_depth(prediction.values, depth_range=settings.depth_range)
    return disparity_to_depth(prediction.values, depth_range=settings.depth_range)


def reset_model_cache() -> None:
    """Drop loaded weights. Exists for tests and for a future 'unload models' admin action."""
    with _CACHE_LOCK:
        _MODEL_CACHE.clear()
