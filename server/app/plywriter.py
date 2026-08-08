"""Minimal 3D Gaussian Splatting ``.ply`` writer.

Emits the canonical inria/3DGS vertex layout (means, normals, DC spherical-harmonic color,
opacity logit, log-scales, quaternion) that Spark, SuperSplat, mkkellogg, etc. all read.

Used by the CPU-only Preview engine to turn an image into a flat, textured plane of
Gaussians so the full create -> explore loop works with no GPU and no downloaded weights, and
by the depth engines to turn an RGB image plus a predicted depth map into a *back-projected*
cloud that has real parallax. Higher-fidelity engines (TripoSplat, SHARP, photogrammetry)
produce their own PLYs.

Everything here is pure numpy/PIL: the depth *maths* is deliberately separated from the depth
*models* so it can be unit-tested on a machine with no torch, no weights and no GPU.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

import numpy as np
from PIL import Image

SH_C0 = 0.28209479177387814  # degree-0 spherical harmonic constant


def _rgb_to_f_dc(rgb01: np.ndarray) -> np.ndarray:
    """Convert linear [0,1] RGB to the DC SH coefficient stored in 3DGS PLYs."""
    return (rgb01 - 0.5) / SH_C0


def write_gaussian_ply(
    path: Path,
    xyz: np.ndarray,        # (N, 3) float
    rgb01: np.ndarray,      # (N, 3) float in [0,1]
    scales: np.ndarray,     # (N, 3) float, world-space std-devs (linear, not log)
    opacity: np.ndarray,    # (N,) float in [0,1]
) -> None:
    n = int(xyz.shape[0])
    fields = [
        "x", "y", "z", "nx", "ny", "nz",
        "f_dc_0", "f_dc_1", "f_dc_2",
        "opacity",
        "scale_0", "scale_1", "scale_2",
        "rot_0", "rot_1", "rot_2", "rot_3",
    ]
    dtype = np.dtype([(f, "<f4") for f in fields])
    arr = np.zeros(n, dtype=dtype)

    arr["x"], arr["y"], arr["z"] = xyz[:, 0], xyz[:, 1], xyz[:, 2]
    # normals left at 0

    f_dc = _rgb_to_f_dc(np.clip(rgb01, 0.0, 1.0))
    arr["f_dc_0"], arr["f_dc_1"], arr["f_dc_2"] = f_dc[:, 0], f_dc[:, 1], f_dc[:, 2]

    eps = 1e-6
    op = np.clip(opacity, eps, 1 - eps)
    arr["opacity"] = np.log(op / (1 - op))  # inverse sigmoid (logit)

    log_scales = np.log(np.clip(scales, 1e-8, None))
    arr["scale_0"], arr["scale_1"], arr["scale_2"] = (
        log_scales[:, 0], log_scales[:, 1], log_scales[:, 2]
    )

    arr["rot_0"] = 1.0  # identity quaternion (w, x, y, z)

    header = (
        "ply\n"
        "format binary_little_endian 1.0\n"
        f"element vertex {n}\n"
        + "".join(f"property float {f}\n" for f in fields)
        + "end_header\n"
    )
    path = Path(path)
    with path.open("wb") as fh:
        fh.write(header.encode("ascii"))
        fh.write(arr.tobytes())


def image_to_flat_gaussian_ply(image_path: Path, out_path: Path, max_dim: int = 200) -> int:
    """Turn an image into a flat, front-facing plane of Gaussians. Returns splat count.

    This is a deliberately simple preview: one Gaussian per downsampled pixel, placed on the
    z=0 plane and colored by the pixel. It is not a reconstruction of unseen geometry, but it
    is a real, orbitable, XR-viewable splat produced entirely on CPU.
    """
    img = Image.open(image_path).convert("RGB")
    w, h = img.size
    scale = min(1.0, max_dim / max(w, h))
    tw, th = max(1, int(w * scale)), max(1, int(h * scale))
    img = img.resize((tw, th), Image.LANCZOS)

    px = np.asarray(img, dtype=np.float32) / 255.0  # (th, tw, 3)
    ys, xs = np.mgrid[0:th, 0:tw]
    aspect = tw / th
    # Center the plane in [-aspect, aspect] x [-1, 1], y up.
    x = (xs / (tw - 1 if tw > 1 else 1) - 0.5) * 2.0 * aspect
    y = -(ys / (th - 1 if th > 1 else 1) - 0.5) * 2.0
    z = np.zeros_like(x)
    xyz = np.stack([x.ravel(), y.ravel(), z.ravel()], axis=1).astype(np.float32)
    rgb = px.reshape(-1, 3)

    spacing = 2.0 / max(th, 2)
    s = spacing * 0.75
    scales = np.tile(np.array([s, s, s * 0.25], dtype=np.float32), (xyz.shape[0], 1))
    opacity = np.ones(xyz.shape[0], dtype=np.float32)

    write_gaussian_ply(out_path, xyz, rgb, scales, opacity)
    return int(xyz.shape[0])


# ── Depth-map back-projection ──────────────────────────────────────────────────────────────
# The depth engines predict a per-pixel depth (or inverse depth) map; the job of the code below
# is to turn that plus the RGB into Gaussians. It is the difference between the Preview engine's
# flat postcard and something you can actually lean around.


def disparity_to_depth(disparity: np.ndarray, depth_range: float = 8.0) -> np.ndarray:
    """Map a relative *inverse-depth* prediction onto a usable metric-ish depth.

    Depth Anything and MiDaS emit disparity in arbitrary units: bigger means nearer, and the
    absolute scale is meaningless. Two things have to happen before back-projection.

    First, normalise robustly. A single blown-out sky pixel or a lens flare can sit ten sigma
    off the rest of the frame; normalising by ``min``/``max`` then compresses the entire real
    scene into a sliver of the range and the reconstruction comes out flat. The 2nd/98th
    percentiles are used instead, and the result is clipped.

    Second, invert. Mapping the normalised disparity *linearly* to depth is the tempting
    one-liner and it is wrong — it spends most of the depth budget on the background, so faces
    end up as reliefs a few millimetres deep. Inverting instead (which is what disparity
    actually means) puts the resolution where the subject is. ``depth_range`` is the resulting
    far/near ratio: the scene occupies depths ``[1, depth_range]``.
    """
    d = np.asarray(disparity, dtype=np.float32)
    finite = np.isfinite(d)
    if not finite.any():
        raise ValueError("disparity map has no finite values")
    lo, hi = np.percentile(d[finite], (2.0, 98.0))
    if not np.isfinite(lo) or not np.isfinite(hi) or hi - lo < 1e-8:
        # Degenerate prediction (a constant map). Everything sits on one plane; say so with a
        # uniform depth rather than dividing by ~zero and emitting NaNs into the PLY.
        return np.ones_like(d, dtype=np.float32)
    norm = np.clip((d - lo) / (hi - lo), 0.0, 1.0)
    near, far = 1.0, max(float(depth_range), 1.0001)
    return (1.0 / (norm * (1.0 / near - 1.0 / far) + 1.0 / far)).astype(np.float32)


def normalize_metric_depth(depth: np.ndarray, depth_range: float = 8.0) -> np.ndarray:
    """Clamp a metric depth map (Depth Pro) into the same ``[1, depth_range]`` working volume.

    Metric predictions are already geometrically correct, but an outdoor shot puts the horizon
    at 1e4 metres; keeping that literal would place 99.9% of the Gaussians in a dot at the
    origin. Rescale by the near percentile and clip the far end, preserving *relative* metric
    structure within the volume we actually render.
    """
    d = np.asarray(depth, dtype=np.float32)
    valid = np.isfinite(d) & (d > 0)
    if not valid.any():
        raise ValueError("metric depth map has no positive finite values")
    near = float(np.percentile(d[valid], 2.0))
    if near <= 0 or not np.isfinite(near):
        near = float(d[valid].min())
    out = np.where(valid, d / max(near, 1e-6), float(depth_range))
    return np.clip(out, 1.0, max(float(depth_range), 1.0001)).astype(np.float32)


def _edge_mask(depth: np.ndarray, drop_percent: float) -> np.ndarray:
    """True where the pixel is *not* on a depth discontinuity.

    A monocular depth map has no idea what is behind the subject, so at every occlusion
    boundary it interpolates. Back-projecting those interpolated pixels produces a curtain of
    Gaussians stretched from the foreground to the background — the "rubber sheet" that makes
    an otherwise good depth splat look broken from any angle but the original one. Discarding
    the steepest few percent of the gradient magnitude removes the curtain and leaves a clean
    silhouette with a hole behind it, which reads far better in the viewer.
    """
    if drop_percent <= 0:
        return np.ones(depth.shape, dtype=bool)
    # Gradient of log-depth: a 10cm step matters at 30cm and not at 30m, and the log makes the
    # threshold scale-free so one percentile works for close-ups and landscapes alike.
    log_d = np.log(np.clip(depth, 1e-6, None))
    gy, gx = np.gradient(log_d)
    mag = np.hypot(gx, gy)

    finite = np.isfinite(mag)
    if not finite.any():
        # Every gradient is NaN/inf, so there is nothing to rank. Keeping the
        # whole frame lets the caller's own validation produce a real error
        # instead of this returning an all-false mask that reads as "the model
        # saw nothing but edges".
        return np.ones(depth.shape, dtype=bool)

    cutoff = float(np.percentile(mag[finite], 100.0 - min(max(drop_percent, 0.0), 99.0)))
    # `finite &` does two jobs: it drops the non-finite pixels themselves (a NaN
    # depth cannot be back-projected), and it stops one bad pixel deciding the
    # whole frame. `np.percentile` over an array containing a single NaN returns
    # NaN, and `mag <= nan` is False EVERYWHERE — so before this, one NaN in the
    # depth map rejected all ~100k points and failed the entire job with an
    # empty cloud rather than losing one pixel.
    return finite & (mag <= cutoff)


def _downsample(rgb: np.ndarray, depth: np.ndarray, max_points: int) -> tuple[np.ndarray, np.ndarray]:
    """Shrink an (H, W, 3) / (H, W) pair so the cloud stays under ``max_points`` Gaussians."""
    h, w = depth.shape[:2]
    if h * w <= max_points or max_points <= 0:
        return rgb, depth
    factor = float(np.sqrt(max_points / float(h * w)))
    tw, th = max(2, int(w * factor)), max(2, int(h * factor))
    rgb_small = np.asarray(
        Image.fromarray(rgb.astype(np.uint8)).resize((tw, th), Image.LANCZOS), dtype=np.uint8
    )
    # NEAREST for depth on purpose: a bilinear resample invents intermediate depths across
    # occlusion boundaries, re-creating exactly the stretched-sheet artefact `_edge_mask` is
    # there to remove — and doing it *after* the mask could no longer see it.
    depth_small = np.asarray(
        Image.fromarray(depth.astype(np.float32), mode="F").resize((tw, th), Image.NEAREST),
        dtype=np.float32,
    )
    return rgb_small, depth_small


def depth_to_gaussian_cloud(
    rgb: np.ndarray,        # (H, W, 3) uint8
    depth: np.ndarray,      # (H, W) float, already in the [1, depth_range] working volume
    *,
    fov_deg: float = 60.0,
    focal_px: Optional[float] = None,
    max_points: int = 400_000,
    edge_drop_percent: float = 2.0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Back-project an RGB-D pair into ``(xyz, rgb01, scales, opacity)``.

    Pinhole camera at the origin looking down -Z, +Y up — the same convention the Preview
    engine's flat plane uses. The cloud is then normalised so the *median-depth* plane lands
    exactly where Preview puts its postcard: spanning [-aspect, aspect] x [-1, 1] at z = 0.
    That continuity is deliberate. Switching a job from ``preview`` to ``depth-image`` should
    reframe nothing in the viewer; the only difference the user sees is that the image now has
    depth. Without it, the same photo lands at a wildly different scale depending on engine and
    the viewer's default camera either clips into it or leaves it a speck.

    ``focal_px`` (from Depth Pro) overrides ``fov_deg`` when the model knows the real optics.
    """
    rgb = np.asarray(rgb)
    depth = np.asarray(depth, dtype=np.float32)
    if rgb.shape[:2] != depth.shape[:2]:
        raise ValueError(f"rgb {rgb.shape[:2]} and depth {depth.shape[:2]} must have equal size")

    if focal_px is not None and focal_px > 0:
        # Rescaling the focal length alongside the image keeps the intrinsics honest after the
        # downsample below; carry it as a fraction of width instead of pixels.
        focal_fraction: Optional[float] = float(focal_px) / float(depth.shape[1])
    else:
        focal_fraction = None

    rgb, depth = _downsample(rgb, depth, max_points)
    h, w = depth.shape[:2]

    fx = focal_fraction * w if focal_fraction else (w / 2.0) / np.tan(np.radians(fov_deg) / 2.0)
    fy = fx  # square pixels; no model here predicts an aspect-distorted focal
    cx, cy = (w - 1) / 2.0, (h - 1) / 2.0

    valid = np.isfinite(depth) & (depth > 0) & _edge_mask(depth, edge_drop_percent)
    if not valid.any():
        raise ValueError("no valid depth samples remain after filtering")

    median_depth = float(np.median(depth[valid]))
    if median_depth <= 0 or not np.isfinite(median_depth):
        median_depth = 1.0
    z_norm = depth / median_depth

    # Framing factor: at the median plane the horizontal extent must equal the image aspect,
    # matching image_to_flat_gaussian_ply. tan(hfov/2) = (w/2)/fx by construction.
    aspect = w / h
    s = aspect / ((w / 2.0) / fx)

    vs, us = np.mgrid[0:h, 0:w]
    x = s * (us - cx) * z_norm / fx
    y = -s * (vs - cy) * z_norm / fy
    z = s * (1.0 - z_norm)  # median plane at 0, nearer content toward the viewer (+z)

    sel = valid.ravel()
    xyz = np.stack([x.ravel(), y.ravel(), z.ravel()], axis=1)[sel].astype(np.float32)
    rgb01 = (rgb.reshape(-1, 3).astype(np.float32) / 255.0)[sel]

    # One Gaussian must cover one pixel's footprint, which grows linearly with depth — a
    # constant radius leaves visible holes in the background and mush in the foreground.
    radius = (0.75 * s * z_norm / fx).ravel()[sel].astype(np.float32)
    scales = np.stack([radius, radius, radius * 0.25], axis=1)
    opacity = np.ones(xyz.shape[0], dtype=np.float32)
    return xyz, rgb01, scales, opacity


def depth_image_to_gaussian_ply(
    image_path: Path,
    depth: np.ndarray,
    out_path: Path,
    *,
    fov_deg: float = 60.0,
    focal_px: Optional[float] = None,
    max_points: int = 400_000,
    edge_drop_percent: float = 2.0,
) -> int:
    """Load ``image_path``, back-project it with ``depth``, write the PLY. Returns splat count.

    ``depth`` must already be true depth in the ``[1, depth_range]`` working volume — run it
    through :func:`disparity_to_depth` or :func:`normalize_metric_depth` first, according to
    what the model emits.
    """
    img = Image.open(image_path).convert("RGB")
    rgb = np.asarray(img, dtype=np.uint8)
    depth = np.asarray(depth, dtype=np.float32)
    if depth.shape[:2] != rgb.shape[:2]:
        # Depth heads run at their own fixed input resolution; resampling to the source image
        # (rather than the reverse) keeps every pixel of colour the user actually uploaded.
        depth = np.asarray(
            Image.fromarray(depth, mode="F").resize((rgb.shape[1], rgb.shape[0]), Image.BILINEAR),
            dtype=np.float32,
        )
    xyz, rgb01, scales, opacity = depth_to_gaussian_cloud(
        rgb,
        depth,
        fov_deg=fov_deg,
        focal_px=focal_px,
        max_points=max_points,
        edge_drop_percent=edge_drop_percent,
    )
    write_gaussian_ply(out_path, xyz, rgb01, scales, opacity)
    return int(xyz.shape[0])
