"""Splat transcoding: 3DGS ``.ply`` -> Niantic ``.spz`` (v2).

``.spz`` (https://github.com/nianticlabs/spz, MIT) is an open, gzip-packed Gaussian format
that is ~10x smaller than ``.ply`` while keeping spherical harmonics — the preferred
on-the-wire format for sharing (Spark loads it natively). The job manager transcodes every
splat asset's master PLY to spz after the engine runs, so shared links stay small.

Both a writer and a reader are implemented; the reader exists so tests can round-trip and
guarantee the writer's layout stays self-consistent.

Layout (v2, little-endian, whole file gzip-compressed):
    header: uint32 magic 'NGSP' (0x5053474e) | uint32 version=2 | uint32 numPoints
            uint8 shDegree | uint8 fractionalBits | uint8 flags | uint8 reserved
    body:   positions  N*3 int24 fixed-point (fractionalBits)
            alphas     N   uint8   sigmoid(opacity_logit)
            colors     N*3 uint8   f_dc*(0.15*255) + 0.5*255
            scales     N*3 uint8   (log_scale + 10) * 16
            rotations  N*3 uint8   quat xyz (w>=0) * 127.5 + 127.5
            sh         N*shDim*3 uint8  coeff*128 + 128   (rgb interleaved per coeff)
"""

from __future__ import annotations

import gzip
import struct
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

SPZ_MAGIC = 0x5053474E  # "NGSP" little-endian
SPZ_VERSION = 2
COLOR_SCALE = 0.15

# f_rest count per channel -> SH degree
_SH_DIM_TO_DEGREE = {0: 0, 3: 1, 8: 2, 15: 3}


@dataclass
class GaussianCloud:
    """Unpacked gaussians in canonical 3DGS units (logit opacity, log scales)."""

    positions: np.ndarray                 # (N, 3) float32
    f_dc: np.ndarray                      # (N, 3) float32 (SH DC coefficient)
    opacity_logit: np.ndarray             # (N,)  float32
    log_scales: np.ndarray                # (N, 3) float32
    rotations: np.ndarray                 # (N, 4) float32 quaternion (w, x, y, z)
    sh: np.ndarray = field(default_factory=lambda: np.zeros((0, 0, 3), dtype=np.float32))
    # (N, shDim, 3) float32; shDim in {0, 3, 8, 15}

    @property
    def count(self) -> int:
        return int(self.positions.shape[0])

    @property
    def sh_degree(self) -> int:
        return _SH_DIM_TO_DEGREE[int(self.sh.shape[1]) if self.sh.size else 0]


# ── PLY reading ────────────────────────────────────────────────────────────────
def read_gaussian_ply(path: Path) -> GaussianCloud:
    """Parse a binary_little_endian 3DGS PLY (the standard inria layout)."""
    with Path(path).open("rb") as fh:
        header_lines: list[str] = []
        while True:
            line = fh.readline().decode("ascii", errors="replace").strip()
            header_lines.append(line)
            if line == "end_header":
                break
            if len(header_lines) > 200:
                raise ValueError("PLY header too large / malformed")

        if "format binary_little_endian 1.0" not in header_lines:
            raise ValueError("Only binary_little_endian PLY is supported")

        count = 0
        props: list[str] = []
        for line in header_lines:
            if line.startswith("element vertex"):
                count = int(line.split()[-1])
            elif line.startswith("property float"):
                props.append(line.split()[-1])
            elif line.startswith("property") and "float" not in line:
                raise ValueError(f"Unsupported PLY property type: {line}")

        dtype = np.dtype([(p, "<f4") for p in props])
        data = np.frombuffer(fh.read(count * dtype.itemsize), dtype=dtype, count=count)

    def col(name: str) -> np.ndarray:
        if name not in props:
            raise ValueError(f"PLY missing required field '{name}'")
        return np.asarray(data[name], dtype=np.float32)

    positions = np.stack([col("x"), col("y"), col("z")], axis=1)
    f_dc = np.stack([col("f_dc_0"), col("f_dc_1"), col("f_dc_2")], axis=1)
    opacity = col("opacity")
    log_scales = np.stack([col("scale_0"), col("scale_1"), col("scale_2")], axis=1)
    rotations = np.stack([col("rot_0"), col("rot_1"), col("rot_2"), col("rot_3")], axis=1)

    rest_names = sorted(
        (p for p in props if p.startswith("f_rest_")), key=lambda p: int(p.split("_")[-1])
    )
    if rest_names:
        n_rest = len(rest_names)
        if n_rest % 3 != 0 or (n_rest // 3) not in _SH_DIM_TO_DEGREE:
            raise ValueError(f"Unsupported f_rest count: {n_rest}")
        sh_dim = n_rest // 3
        rest = np.stack([np.asarray(data[p], dtype=np.float32) for p in rest_names], axis=1)
        # PLY stores channel-major (all R coeffs, all G, all B); spz wants per-coeff RGB.
        sh = rest.reshape(-1, 3, sh_dim).transpose(0, 2, 1).copy()
    else:
        sh = np.zeros((count, 0, 3), dtype=np.float32)

    return GaussianCloud(positions, f_dc, opacity, log_scales, rotations, sh)


# ── SPZ writing / reading ─────────────────────────────────────────────────────
def _pack_int24(values: np.ndarray) -> bytes:
    """Pack int32 values into little-endian signed 24-bit triplets."""
    v = np.clip(values, -(1 << 23), (1 << 23) - 1).astype(np.int32)
    out = np.empty((v.size, 3), dtype=np.uint8)
    out[:, 0] = v & 0xFF
    out[:, 1] = (v >> 8) & 0xFF
    out[:, 2] = (v >> 16) & 0xFF
    return out.tobytes()


def _unpack_int24(raw: bytes) -> np.ndarray:
    b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
    v = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
    return np.where(v >= (1 << 23), v - (1 << 24), v)


def _u8(values: np.ndarray) -> np.ndarray:
    return np.clip(np.rint(values), 0, 255).astype(np.uint8)


def write_spz(cloud: GaussianCloud, path: Path, fractional_bits: int = 12) -> None:
    n = cloud.count
    header = struct.pack(
        "<IIIBBBB", SPZ_MAGIC, SPZ_VERSION, n, cloud.sh_degree, fractional_bits, 0, 0
    )

    positions = _pack_int24(np.rint(cloud.positions.reshape(-1) * (1 << fractional_bits)))
    alphas = _u8(255.0 / (1.0 + np.exp(-cloud.opacity_logit))).tobytes()
    colors = _u8(cloud.f_dc.reshape(-1) * (COLOR_SCALE * 255.0) + 0.5 * 255.0).tobytes()
    scales = _u8((cloud.log_scales.reshape(-1) + 10.0) * 16.0).tobytes()

    # Normalize, flip so w >= 0, store xyz.
    q = cloud.rotations / np.maximum(
        np.linalg.norm(cloud.rotations, axis=1, keepdims=True), 1e-12
    )
    q = np.where(q[:, :1] < 0, -q, q)
    rotations = _u8(q[:, 1:4].reshape(-1) * 127.5 + 127.5).tobytes()

    sh = _u8(cloud.sh.reshape(-1) * 128.0 + 128.0).tobytes() if cloud.sh.size else b""

    payload = header + positions + alphas + colors + scales + rotations + sh
    Path(path).write_bytes(gzip.compress(payload))


def read_spz(path: Path) -> GaussianCloud:
    payload = gzip.decompress(Path(path).read_bytes())
    magic, version, n, sh_degree, fractional_bits, _flags, _res = struct.unpack(
        "<IIIBBBB", payload[:16]
    )
    if magic != SPZ_MAGIC:
        raise ValueError("Not an spz file")
    if version != SPZ_VERSION:
        raise ValueError(f"Unsupported spz version {version}")

    sh_dim = {0: 0, 1: 3, 2: 8, 3: 15}[sh_degree]
    off = 16
    positions = (
        _unpack_int24(payload[off : off + n * 9]).reshape(-1, 3).astype(np.float32)
        / (1 << fractional_bits)
    )
    off += n * 9
    alphas = np.frombuffer(payload[off : off + n], dtype=np.uint8).astype(np.float32) / 255.0
    off += n
    a = np.clip(alphas, 1e-6, 1 - 1e-6)
    opacity_logit = np.log(a / (1 - a)).astype(np.float32)
    colors = np.frombuffer(payload[off : off + n * 3], dtype=np.uint8).reshape(-1, 3)
    off += n * 3
    f_dc = ((colors.astype(np.float32) / 255.0) - 0.5) / COLOR_SCALE
    scales = np.frombuffer(payload[off : off + n * 3], dtype=np.uint8).reshape(-1, 3)
    off += n * 3
    log_scales = scales.astype(np.float32) / 16.0 - 10.0
    rot = np.frombuffer(payload[off : off + n * 3], dtype=np.uint8).reshape(-1, 3)
    off += n * 3
    xyz = (rot.astype(np.float32) - 127.5) / 127.5
    w = np.sqrt(np.clip(1.0 - np.sum(xyz * xyz, axis=1), 0.0, 1.0))
    rotations = np.concatenate([w[:, None], xyz], axis=1).astype(np.float32)

    if sh_dim:
        sh_raw = np.frombuffer(payload[off : off + n * sh_dim * 3], dtype=np.uint8)
        sh = ((sh_raw.astype(np.float32) - 128.0) / 128.0).reshape(n, sh_dim, 3)
    else:
        sh = np.zeros((n, 0, 3), dtype=np.float32)

    return GaussianCloud(positions, f_dc, opacity_logit, log_scales, rotations, sh)


def ply_to_spz(ply_path: Path, spz_path: Path) -> None:
    """Transcode a 3DGS PLY to spz."""
    write_spz(read_gaussian_ply(ply_path), spz_path)
