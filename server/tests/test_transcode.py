"""PLY -> SPZ transcoding: round-trip consistency and size reduction."""

import gzip
import struct
from pathlib import Path

import numpy as np
from PIL import Image

from app.plywriter import image_to_flat_gaussian_ply
from app.transcode import (
    SPZ_MAGIC,
    SPZ_VERSION,
    GaussianCloud,
    ply_to_spz,
    read_gaussian_ply,
    read_spz,
    write_spz,
)


def _random_cloud(n=500, sh_dim=0, seed=7) -> GaussianCloud:
    rng = np.random.default_rng(seed)
    q = rng.normal(size=(n, 4)).astype(np.float32)
    q /= np.linalg.norm(q, axis=1, keepdims=True)
    return GaussianCloud(
        positions=rng.uniform(-3, 3, size=(n, 3)).astype(np.float32),
        f_dc=rng.uniform(-1.5, 1.5, size=(n, 3)).astype(np.float32),
        opacity_logit=rng.uniform(-4, 4, size=n).astype(np.float32),
        log_scales=rng.uniform(-8, 0, size=(n, 3)).astype(np.float32),
        rotations=q,
        sh=rng.uniform(-0.4, 0.4, size=(n, sh_dim, 3)).astype(np.float32),
    )


def test_spz_round_trip(tmp_path: Path):
    cloud = _random_cloud()
    out = tmp_path / "m.spz"
    write_spz(cloud, out)

    # Header sanity on the raw payload.
    payload = gzip.decompress(out.read_bytes())
    magic, version, n, sh_degree, frac_bits, _, _ = struct.unpack("<IIIBBBB", payload[:16])
    assert (magic, version, n, sh_degree) == (SPZ_MAGIC, SPZ_VERSION, cloud.count, 0)
    assert frac_bits == 12

    back = read_spz(out)
    assert back.count == cloud.count
    np.testing.assert_allclose(back.positions, cloud.positions, atol=1.5 / (1 << 12))
    np.testing.assert_allclose(back.f_dc, cloud.f_dc, atol=1.0 / (0.15 * 255) + 1e-3)
    np.testing.assert_allclose(back.log_scales, cloud.log_scales, atol=1.0 / 16 + 1e-3)
    # Quaternions: compare up to sign via |dot| ~ 1. Worst case is quats with w ~ 0, where
    # reconstructing w = sqrt(1 - |xyz|^2) amplifies the 8-bit xyz quantization error — an
    # inherent property of the spz rotation encoding, so the floor is looser than the mean.
    dots = np.abs(np.sum(back.rotations * cloud.rotations, axis=1))
    assert float(np.mean(dots)) > 0.9999
    assert np.all(dots > 0.995)
    # Opacity survives through sigmoid/logit quantization.
    sig = lambda x: 1 / (1 + np.exp(-x))  # noqa: E731
    np.testing.assert_allclose(sig(back.opacity_logit), sig(cloud.opacity_logit), atol=1 / 255 + 1e-4)


def test_spz_round_trip_with_sh(tmp_path: Path):
    cloud = _random_cloud(n=100, sh_dim=15)  # degree 3
    out = tmp_path / "m.spz"
    write_spz(cloud, out)
    back = read_spz(out)
    assert back.sh_degree == 3
    np.testing.assert_allclose(back.sh, cloud.sh, atol=1 / 128 + 1e-3)


def test_ply_to_spz_shrinks_preview_output(tmp_path: Path):
    img = tmp_path / "in.png"
    Image.effect_noise((96, 96), 64).convert("RGB").save(img)
    ply = tmp_path / "m.ply"
    image_to_flat_gaussian_ply(img, ply, max_dim=96)

    spz = tmp_path / "m.spz"
    ply_to_spz(ply, spz)

    cloud = read_gaussian_ply(ply)
    back = read_spz(spz)
    assert back.count == cloud.count
    np.testing.assert_allclose(back.positions, cloud.positions, atol=1.5 / (1 << 12))
    # The whole point: much smaller on the wire.
    assert spz.stat().st_size < ply.stat().st_size * 0.35
