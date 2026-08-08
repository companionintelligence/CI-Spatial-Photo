"""What the PLY reader and the spz reader do with files they cannot trust.

`test_transcode.py` round-trips clouds this project wrote itself. This file feeds the readers
things they did not write: ASCII PLYs, PLYs from other tools with extra property types, headers
that never end, spherical-harmonic layouts, and truncated or foreign spz. TripoSplat, SHARP and
photogrammetry all hand back a PLY produced by *someone else's* binary, so the reader is a trust
boundary, and "the transcode silently produced garbage" is far worse than "the transcode
raised" — the job manager treats a raise as best-effort and still ships the master file.
"""

import gzip
import struct
from pathlib import Path

import numpy as np
import pytest

from app.transcode import (
    COLOR_SCALE,
    SPZ_MAGIC,
    SPZ_VERSION,
    GaussianCloud,
    ply_to_spz,
    read_gaussian_ply,
    read_spz,
    write_spz,
)

BASE_FIELDS = [
    "x", "y", "z", "nx", "ny", "nz",
    "f_dc_0", "f_dc_1", "f_dc_2",
    "opacity",
    "scale_0", "scale_1", "scale_2",
    "rot_0", "rot_1", "rot_2", "rot_3",
]


def _write_ply(path: Path, fields: list[str], rows: np.ndarray, *, fmt: str | None = None) -> Path:
    """Write a binary PLY with an arbitrary property list — including invalid ones."""
    header = (
        "ply\n"
        + (fmt or "format binary_little_endian 1.0") + "\n"
        + f"element vertex {rows.shape[0]}\n"
        + "".join(f"property float {f}\n" for f in fields)
        + "end_header\n"
    )
    dtype = np.dtype([(f, "<f4") for f in fields])
    arr = np.zeros(rows.shape[0], dtype=dtype)
    for i, f in enumerate(fields):
        arr[f] = rows[:, i]
    path.write_bytes(header.encode("ascii") + arr.tobytes())
    return path


# ── PLY header validation ─────────────────────────────────────────────────────────────────

def test_an_ascii_ply_is_rejected_rather_than_read_as_binary(tmp_path: Path):
    """Half the tools in this ecosystem export ASCII by default; reading it as binary would
    produce a cloud of plausible-looking noise instead of an error."""
    path = _write_ply(
        tmp_path / "ascii.ply", BASE_FIELDS, np.zeros((2, len(BASE_FIELDS)), dtype=np.float32),
        fmt="format ascii 1.0",
    )
    with pytest.raises(ValueError, match="binary_little_endian"):
        read_gaussian_ply(path)


def test_a_non_float_property_is_rejected_instead_of_silently_shifting_every_field(tmp_path: Path):
    """`property uchar red` is one byte, not four.

    The reader builds one `<f4` dtype for the whole vertex, so a single non-float property
    desynchronises every subsequent field by three bytes — positions become garbage and
    nothing anywhere reports a problem. Refusing is the only safe answer.
    """
    header = (
        "ply\nformat binary_little_endian 1.0\nelement vertex 1\n"
        "property float x\nproperty uchar red\nend_header\n"
    )
    path = tmp_path / "mixed.ply"
    path.write_bytes(header.encode("ascii") + b"\x00" * 5)
    with pytest.raises(ValueError, match="Unsupported PLY property type"):
        read_gaussian_ply(path)


def test_a_header_with_no_end_marker_terminates_instead_of_spinning(tmp_path: Path):
    """At EOF `readline` returns b"" forever; the 200-line cap is what stops the loop.

    Without it a truncated download does not raise, it hangs the worker thread — and the job
    just sits at "transcoding" until someone restarts the server.
    """
    path = tmp_path / "runaway.ply"
    path.write_bytes(b"ply\nformat binary_little_endian 1.0\n" + b"comment padding\n" * 300)
    with pytest.raises(ValueError, match="header too large"):
        read_gaussian_ply(path)


def test_a_ply_missing_a_gaussian_field_names_the_field(tmp_path: Path):
    """A plain point cloud (x/y/z only) is a legal PLY and a common mistake to feed in here."""
    path = _write_ply(tmp_path / "points.ply", ["x", "y", "z"], np.zeros((4, 3), dtype=np.float32))
    with pytest.raises(ValueError, match="f_dc_0"):
        read_gaussian_ply(path)


# ── spherical harmonics ───────────────────────────────────────────────────────────────────

def test_spherical_harmonics_are_transposed_from_channel_major_to_per_coefficient_rgb(tmp_path):
    """The one layout conversion in the reader, and it is invisible when it is wrong.

    A 3DGS PLY stores f_rest channel-major: coefficients 0..14 are all RED, 15..29 all GREEN,
    30..44 all BLUE. spz wants them interleaved per coefficient. Get the transpose backwards
    and the cloud still loads, still has the right point count, and every view-dependent
    highlight is simply the wrong colour. Encoding the index in the value makes the mapping
    checkable rather than merely plausible.
    """
    sh_dim = 15
    fields = BASE_FIELDS + [f"f_rest_{i}" for i in range(sh_dim * 3)]
    rows = np.zeros((2, len(fields)), dtype=np.float32)
    for i in range(sh_dim * 3):
        rows[:, len(BASE_FIELDS) + i] = i / 100.0

    cloud = read_gaussian_ply(_write_ply(tmp_path / "sh.ply", fields, rows))
    assert cloud.sh.shape == (2, sh_dim, 3)
    assert cloud.sh_degree == 3
    for coeff in range(sh_dim):
        assert cloud.sh[0, coeff, 0] == pytest.approx(coeff / 100.0)                 # red
        assert cloud.sh[0, coeff, 1] == pytest.approx((sh_dim + coeff) / 100.0)      # green
        assert cloud.sh[0, coeff, 2] == pytest.approx((2 * sh_dim + coeff) / 100.0)  # blue


def test_f_rest_fields_are_ordered_numerically_not_lexically(tmp_path: Path):
    """`sorted()` on the raw names puts f_rest_10 before f_rest_2, which shuffles the whole
    coefficient block. The reader sorts on the parsed integer; this pins that it must."""
    sh_dim = 8  # degree 2 — 24 fields, so the 2-vs-10 ordering trap is live
    fields = BASE_FIELDS + [f"f_rest_{i}" for i in range(sh_dim * 3)]
    rows = np.zeros((1, len(fields)), dtype=np.float32)
    for i in range(sh_dim * 3):
        rows[:, len(BASE_FIELDS) + i] = i

    cloud = read_gaussian_ply(_write_ply(tmp_path / "sh8.ply", fields, rows))
    assert cloud.sh_degree == 2
    assert list(cloud.sh[0, :, 0]) == pytest.approx(list(range(sh_dim)))


def test_a_spherical_harmonic_count_no_degree_produces_is_rejected(tmp_path: Path):
    """6 f_rest fields is 2 coefficients per channel — no SH degree has 2."""
    fields = BASE_FIELDS + [f"f_rest_{i}" for i in range(6)]
    rows = np.zeros((1, len(fields)), dtype=np.float32)
    with pytest.raises(ValueError, match="Unsupported f_rest count"):
        read_gaussian_ply(_write_ply(tmp_path / "odd.ply", fields, rows))


def test_a_ply_with_harmonics_survives_the_whole_transcode(tmp_path: Path):
    """End to end: the reason spz is preferred over ply is that it keeps SH and still shrinks."""
    sh_dim = 15
    fields = BASE_FIELDS + [f"f_rest_{i}" for i in range(sh_dim * 3)]
    rng = np.random.default_rng(11)
    rows = rng.uniform(-0.4, 0.4, size=(300, len(fields))).astype(np.float32)
    rows[:, 13] = 1.0  # rot_0 = w; an all-zero quaternion has no normalised form
    ply = _write_ply(tmp_path / "m.ply", fields, rows)

    spz = tmp_path / "m.spz"
    ply_to_spz(ply, spz)
    back = read_spz(spz)
    assert back.sh_degree == 3
    np.testing.assert_allclose(back.sh, read_gaussian_ply(ply).sh, atol=1 / 128 + 1e-3)
    assert spz.stat().st_size < ply.stat().st_size * 0.5


# ── spz header validation ─────────────────────────────────────────────────────────────────

def test_a_file_that_is_not_spz_is_rejected_by_its_magic(tmp_path: Path):
    path = tmp_path / "foreign.spz"
    path.write_bytes(gzip.compress(struct.pack("<IIIBBBB", 0xDEADBEEF, 2, 0, 0, 12, 0, 0)))
    with pytest.raises(ValueError, match="Not an spz file"):
        read_spz(path)


def test_a_future_spz_version_is_refused_rather_than_misparsed(tmp_path: Path):
    """v3 may reorder the body; parsing it with v2 offsets would yield a valid-looking cloud."""
    path = tmp_path / "v3.spz"
    path.write_bytes(gzip.compress(struct.pack("<IIIBBBB", SPZ_MAGIC, 3, 0, 0, 12, 0, 0)))
    with pytest.raises(ValueError, match="Unsupported spz version 3"):
        read_spz(path)


# ── quantisation limits ───────────────────────────────────────────────────────────────────

def test_a_position_beyond_the_int24_range_saturates_instead_of_wrapping(tmp_path: Path):
    """spz stores positions as 24-bit fixed point: +/-2048 at 12 fractional bits.

    Without the clip, a point past that range wraps around the two's-complement boundary and
    teleports to the *opposite* side of the scene — one stray Gaussian from a bad
    reconstruction drags the viewer's auto-framing to infinity and the asset renders empty.
    Clamping keeps it at the edge, which is visible and harmless.
    """
    n = 3
    positions = np.array(
        [[5_000.0, -5_000.0, 0.0], [0.0, 0.0, 2_047.0], [1.5, -1.5, 0.25]], dtype=np.float32
    )
    cloud = GaussianCloud(
        positions=positions,
        f_dc=np.zeros((n, 3), dtype=np.float32),
        opacity_logit=np.zeros(n, dtype=np.float32),
        log_scales=np.zeros((n, 3), dtype=np.float32),
        rotations=np.tile(np.array([1.0, 0, 0, 0], dtype=np.float32), (n, 1)),
    )
    out = tmp_path / "clipped.spz"
    write_spz(cloud, out)
    back = read_spz(out)

    limit = (1 << 23) / (1 << 12)  # 2048.0
    assert back.positions[0, 0] == pytest.approx(limit, abs=0.001)
    assert back.positions[0, 1] == pytest.approx(-limit, abs=0.001)
    assert back.positions[0, 0] > 0 and back.positions[0, 1] < 0, "the sign must not flip"
    np.testing.assert_allclose(back.positions[1:], positions[1:], atol=1.5 / (1 << 12))


def test_an_empty_cloud_transcodes_to_a_readable_empty_spz(tmp_path: Path):
    """An engine can legitimately produce nothing; the transcode must not corrupt the header."""
    empty = GaussianCloud(
        positions=np.zeros((0, 3), dtype=np.float32),
        f_dc=np.zeros((0, 3), dtype=np.float32),
        opacity_logit=np.zeros(0, dtype=np.float32),
        log_scales=np.zeros((0, 3), dtype=np.float32),
        rotations=np.zeros((0, 4), dtype=np.float32),
    )
    out = tmp_path / "empty.spz"
    write_spz(empty, out)
    magic, version, n, *_ = struct.unpack("<IIIBBBB", gzip.decompress(out.read_bytes())[:16])
    assert (magic, version, n) == (SPZ_MAGIC, SPZ_VERSION, 0)
    assert read_spz(out).count == 0


def test_colour_saturates_at_the_ends_of_the_eight_bit_range(tmp_path: Path):
    """f_dc is unbounded; spz colour is one byte scaled by 0.15. Out-of-range must clamp.

    A wrap here is the same class of bug as the position one and much more visible: a blown
    highlight would come back as black.
    """
    n = 2
    extreme = 1.0 / COLOR_SCALE * 4  # far outside anything a real SH DC term reaches
    cloud = GaussianCloud(
        positions=np.zeros((n, 3), dtype=np.float32),
        f_dc=np.array([[extreme] * 3, [-extreme] * 3], dtype=np.float32),
        opacity_logit=np.zeros(n, dtype=np.float32),
        log_scales=np.zeros((n, 3), dtype=np.float32),
        rotations=np.tile(np.array([1.0, 0, 0, 0], dtype=np.float32), (n, 1)),
    )
    out = tmp_path / "hot.spz"
    write_spz(cloud, out)
    back = read_spz(out)
    # 255 and 0 map back through (v/255 - 0.5)/0.15 to the ends of the representable range.
    assert np.all(back.f_dc[0] > 0) and np.all(back.f_dc[1] < 0)
    assert np.all(np.abs(back.f_dc) <= abs((1.0 - 0.5) / COLOR_SCALE) + 1e-6)
