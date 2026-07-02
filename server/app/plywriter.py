"""Minimal 3D Gaussian Splatting ``.ply`` writer.

Emits the canonical inria/3DGS vertex layout (means, normals, DC spherical-harmonic color,
opacity logit, log-scales, quaternion) that Spark, SuperSplat, mkkellogg, etc. all read.

Used by the CPU-only Preview engine to turn an image into a flat, textured plane of
Gaussians so the full create -> explore loop works with no GPU and no downloaded weights.
Higher-fidelity engines (TripoSplat, SHARP, photogrammetry) produce their own PLYs.
"""

from __future__ import annotations

from pathlib import Path

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
