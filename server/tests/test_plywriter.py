"""The Preview engine's Gaussian-PLY output is well-formed."""

import struct
from pathlib import Path

from PIL import Image

from app.plywriter import image_to_flat_gaussian_ply


def _make_image(path: Path, w=64, h=48):
    Image.new("RGB", (w, h), (120, 60, 200)).save(path)


def test_flat_gaussian_ply_is_valid(tmp_path: Path):
    img = tmp_path / "in.png"
    _make_image(img)
    out = tmp_path / "out.ply"
    count = image_to_flat_gaussian_ply(img, out, max_dim=32)

    assert out.exists() and count > 0
    with out.open("rb") as fh:
        header = b""
        while b"end_header\n" not in header:
            header += fh.readline()
        text = header.decode("ascii")
        assert text.startswith("ply\n")
        assert "format binary_little_endian 1.0" in text
        assert f"element vertex {count}" in text
        for field in ("f_dc_0", "opacity", "scale_0", "rot_0"):
            assert f"property float {field}" in text
        # 17 float32 fields per vertex.
        body = fh.read()
        assert len(body) == count * 17 * 4
        first = struct.unpack("<17f", body[: 17 * 4])
        assert first[13] == 1.0  # rot_0 (w) identity quaternion
