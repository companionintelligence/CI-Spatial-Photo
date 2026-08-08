"""Degenerate inputs to the depth back-projector, and the PLY file it writes.

`test_depth_geometry.py` covers the happy path — a sensible depth map producing sensible
parallax. This file covers what arrives when the input is *not* sensible: one-pixel images,
all-NaN predictions, constant maps, extreme aspect ratios, and colour/scale values at the ends
of their ranges. A monocular depth head really does emit NaN and really does get handed a
1024x1 crop, and every one of these paths used to reach the user as a numpy message or a
malformed file rather than as a clean error or a correct result.

Pure numpy/PIL: no torch, no weights, no network.
"""

from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from app.plywriter import (
    SH_C0,
    _downsample,
    _edge_mask,
    depth_image_to_gaussian_ply,
    depth_to_gaussian_cloud,
    disparity_to_depth,
    normalize_metric_depth,
    write_gaussian_ply,
)
from app.transcode import read_gaussian_ply

PLY_FIELDS = 17  # x y z nx ny nz f_dc*3 opacity scale*3 rot*4


def _rgb(h: int, w: int, value: int = 128) -> np.ndarray:
    return np.full((h, w, 3), value, dtype=np.uint8)


# ── degenerate shapes ─────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("shape", [(1, 1), (1, 32), (32, 1)])
def test_a_one_pixel_dimension_back_projects_instead_of_dying_in_the_gradient(shape):
    """Regression: `np.gradient` needs two samples per axis and raised on anything thinner.

    `_edge_mask` called `np.gradient` unconditionally, so a 1-pixel-wide or 1-pixel-tall image
    — a legal upload, and exactly what a thin crop or a spacer image is — aborted the whole
    back-projection with `ValueError: Shape of array too small to calculate a numerical
    gradient`. `depth_image.run` wraps ValueError as "Depth map from '<model>' was unusable",
    so the user was told the *model* failed on a prediction that was completely fine.
    """
    h, w = shape
    xyz, rgb01, scales, opacity = depth_to_gaussian_cloud(
        _rgb(h, w), np.ones((h, w), dtype=np.float32), edge_drop_percent=2.0
    )
    assert xyz.shape[0] == h * w, "a thin image must keep every pixel, not lose them to a mask"
    assert np.isfinite(xyz).all()
    assert rgb01.shape[0] == scales.shape[0] == opacity.shape[0] == xyz.shape[0]


def test_a_two_pixel_dimension_still_runs_the_real_edge_mask():
    """The guard above must be a floor, not a blanket bypass: 2 samples is enough to rank."""
    depth = np.array([[1.0, 1.0], [1.0, 9.0]], dtype=np.float32)
    mask = _edge_mask(depth, 50.0)
    assert mask.sum() < mask.size, "with a real step and a 50% drop, something must be rejected"


def test_all_nan_depth_raises_and_writes_no_file(tmp_path: Path):
    """A failed prediction must not leave a truncated PLY behind for the store to publish."""
    img = tmp_path / "in.png"
    Image.new("RGB", (16, 12), (10, 20, 30)).save(img)
    out = tmp_path / "master.ply"
    with pytest.raises(ValueError):
        depth_image_to_gaussian_ply(img, np.full((12, 16), np.nan, dtype=np.float32), out)
    assert not out.exists()


def test_all_equal_depth_keeps_every_pixel_despite_the_edge_percentile():
    """A flat map has no edges, so the 2% drop must find nothing to drop.

    `_edge_mask` ranks pixels by gradient magnitude and cuts the top N%. On a constant map
    every magnitude is exactly 0, and the cutoff is 0 too — a `<` comparison instead of `<=`
    would silently throw away 2% of a perfectly uniform frame.
    """
    h, w = 24, 32
    xyz, _, _, _ = depth_to_gaussian_cloud(
        _rgb(h, w), np.full((h, w), 3.0, dtype=np.float32), edge_drop_percent=2.0
    )
    assert xyz.shape[0] == h * w
    assert np.allclose(xyz[:, 2], 0.0, atol=1e-6), "one depth = one plane, at the median"


@pytest.mark.parametrize("shape", [(4, 256), (256, 4), (48, 64)])
def test_extreme_aspect_ratios_land_exactly_on_the_derived_framing_box(shape):
    """The framing contract at any aspect ratio, derived rather than eyeballed.

    Gaussians sit at pixel *centres*, so the outermost one is half a pixel inside the nominal
    [-aspect, aspect] x [-1, 1] box. Substituting fx = focal_fraction*w (or (w/2)/tan(hfov/2))
    into s = aspect / ((w/2)/fx) gives s/fx = 2*aspect/w, hence

        x_max = s * ((w-1)/2) / fx = aspect * (w-1)/w
        y_max = s * ((h-1)/2) / fy = aspect * (h-1)/w = (h-1)/h

    which is exact, so this asserts to 1e-6 rather than to a hand-tuned 2% tolerance. A
    panorama and a column crop are the pair that catches an x/y or w/h transposition: swap the
    axes and one of the two still passes while the other is out by aspect squared.
    """
    h, w = shape
    aspect = w / h
    xyz, _, _, _ = depth_to_gaussian_cloud(
        _rgb(h, w), np.ones((h, w), dtype=np.float32), edge_drop_percent=0.0
    )
    assert xyz[:, 0].max() == pytest.approx(aspect * (w - 1) / w, rel=1e-6)
    assert xyz[:, 0].min() == pytest.approx(-aspect * (w - 1) / w, rel=1e-6)
    assert xyz[:, 1].max() == pytest.approx((h - 1) / h, rel=1e-6)
    assert xyz[:, 1].min() == pytest.approx(-(h - 1) / h, rel=1e-6)


# ── the edge mask ─────────────────────────────────────────────────────────────────────────

def test_a_non_positive_drop_percent_disables_the_mask_entirely():
    depth = np.tile(np.linspace(1.0, 8.0, 16, dtype=np.float32), (16, 1))
    for percent in (0.0, -5.0):
        assert _edge_mask(depth, percent).all()


def test_an_absurd_drop_percent_is_clamped_instead_of_emptying_the_frame():
    """`drop_percent=200` means percentile(-100), which numpy rejects outright.

    The clamp to 99 is what keeps a mis-configured DEPTH_EDGE_DROP_PERCENT from turning every
    job into "no valid depth samples remain after filtering".
    """
    depth = np.tile(np.linspace(1.0, 8.0, 16, dtype=np.float32), (16, 1))
    assert _edge_mask(depth, 200.0).sum() > 0


def test_the_mask_rejects_the_boundary_and_keeps_both_plateaus():
    """Which pixels are dropped matters, not just how many: the step, not the flat regions."""
    depth = np.full((16, 16), 6.0, dtype=np.float32)
    depth[:, 8:] = 1.0
    mask = _edge_mask(depth, 20.0)
    # np.gradient uses central differences, so a step between columns 7 and 8 shows up as a
    # non-zero gradient on BOTH of them (col 7 differences 6 against 8) and nowhere else. The
    # plateau interiors must survive untouched — dropping them would eat the subject.
    assert not mask[:, 7].any() and not mask[:, 8].any()
    assert mask[:, :7].all() and mask[:, 9:].all()


def test_the_drop_is_a_percentile_not_a_threshold_so_a_busy_frame_keeps_everything():
    """A property worth knowing before tuning DEPTH_EDGE_DROP_PERCENT on a real photo.

    `_edge_mask` cuts the top N% of gradient magnitudes, so it removes an occlusion boundary
    only while that boundary is *smaller* than N% of the frame. The two columns below are
    2*16/256 = 12.5% of the pixels: at drop=20 they go, at drop=10 the cutoff lands inside the
    edge population itself and `mag <= cutoff` keeps the entire frame. That is by design — the
    alternative, an absolute threshold, has no scale-free value that works for both a portrait
    and a landscape — but it means the setting cannot be read as "always removes the seam".
    """
    depth = np.full((16, 16), 6.0, dtype=np.float32)
    depth[:, 8:] = 1.0
    assert _edge_mask(depth, 20.0).sum() == 256 - 32
    assert _edge_mask(depth, 10.0).sum() == 256


# ── downsampling ──────────────────────────────────────────────────────────────────────────

def test_downsampling_never_invents_a_depth_between_two_planes():
    """The stated reason `_downsample` uses NEAREST for depth and LANCZOS for colour.

    A bilinear/Lanczos resample of the depth channel averages across an occlusion boundary and
    manufactures intermediate depths — re-creating the stretched-sheet artefact `_edge_mask`
    exists to remove, and doing it *after* the mask has already run and cannot see it.
    """
    h, w = 120, 120
    depth = np.full((h, w), 6.0, dtype=np.float32)
    depth[:, 60:] = 1.0
    xyz, _, _, _ = depth_to_gaussian_cloud(
        _rgb(h, w), depth, max_points=900, edge_drop_percent=0.0
    )
    assert xyz.shape[0] <= 900
    assert len(np.unique(np.round(xyz[:, 2], 4))) == 2, "resampling introduced a third depth"


def test_downsampling_is_skipped_when_the_budget_is_zero_or_negative():
    """`max_points<=0` means "no limit"; it must not collapse the cloud to nothing."""
    h, w = 20, 20
    rgb, depth = _rgb(h, w), np.ones((h, w), dtype=np.float32)
    for budget in (0, -1):
        out_rgb, out_depth = _downsample(rgb, depth, budget)
        assert out_rgb.shape == rgb.shape and out_depth.shape == depth.shape


def test_an_impossible_budget_floors_at_two_by_two_rather_than_emptying_the_cloud():
    """`max_points=1` computes a 0x0 target; the max(2, ...) floor is what stops that."""
    xyz, _, _, _ = depth_to_gaussian_cloud(
        _rgb(64, 64), np.ones((64, 64), dtype=np.float32), max_points=1, edge_drop_percent=0.0
    )
    assert xyz.shape[0] == 4


def test_colour_stays_registered_to_geometry_through_the_downsample():
    """Colour and depth are resized by two different code paths and two different filters.

    Nothing in the shapes catches a transpose or an off-by-one between them — the cloud is
    still the right size, the colours are just on the wrong Gaussians. Pin it with a red near
    half and a blue far half and check the colours land on the correct side of the median.
    """
    h, w = 100, 100
    rgb = np.zeros((h, w, 3), dtype=np.uint8)
    rgb[:, :50] = (255, 0, 0)   # left half red
    rgb[:, 50:] = (0, 0, 255)   # right half blue
    depth = np.full((h, w), 5.0, dtype=np.float32)
    depth[:, :50] = 1.0         # left half near

    xyz, rgb01, _, _ = depth_to_gaussian_cloud(
        rgb, depth, max_points=1_000, edge_drop_percent=0.0
    )
    near = xyz[:, 2] > 0.01
    assert near.any() and (~near).any()
    assert rgb01[near, 0].mean() > 0.9, "the near half must still be the red half"
    assert rgb01[~near, 2].mean() > 0.9, "the far half must still be the blue half"


def test_a_predicted_focal_length_survives_the_downsample_unchanged():
    """`focal_px` is carried as a fraction of width precisely so the budget cannot reframe.

    fx = focal_fraction * w and s = aspect / ((w/2)/fx) = 2 * aspect * focal_fraction, so the
    framing is independent of the post-downsample width. Store it in pixels instead and the
    same photo lands at a different scale depending on how many points the operator allowed.
    """
    h, w = 90, 120
    depth = np.linspace(1.0, 3.0, h * w, dtype=np.float32).reshape(h, w)
    full, _, _, _ = depth_to_gaussian_cloud(
        _rgb(h, w), depth, focal_px=300.0, max_points=10**6, edge_drop_percent=0.0
    )
    reduced, _, _, _ = depth_to_gaussian_cloud(
        _rgb(h, w), depth, focal_px=300.0, max_points=1_500, edge_drop_percent=0.0
    )
    assert reduced.shape[0] < full.shape[0]
    assert reduced[:, 0].max() == pytest.approx(full[:, 0].max(), rel=0.05)
    assert reduced[:, 1].max() == pytest.approx(full[:, 1].max(), rel=0.05)


# ── normalisation edge cases ──────────────────────────────────────────────────────────────

def test_a_single_finite_disparity_pixel_becomes_a_plane_not_a_nan_field():
    """The 2nd and 98th percentiles coincide when there is one sample; hi-lo must not divide."""
    disparity = np.full((8, 8), np.nan, dtype=np.float32)
    disparity[4, 4] = 0.7
    depth = disparity_to_depth(disparity)
    assert np.isfinite(depth).all()
    assert np.allclose(depth, 1.0)


def test_metric_depth_with_nothing_positive_raises():
    """Zeros, negatives and NaN are all "the model told us nothing", and must say so."""
    for bad in (np.zeros((4, 4)), np.full((4, 4), -3.0), np.full((4, 4), np.nan)):
        with pytest.raises(ValueError, match="positive finite"):
            normalize_metric_depth(bad.astype(np.float32))


def test_metric_depth_banishes_invalid_samples_to_the_far_plane():
    """An invalid sample must not set the scale, and must not come back as NaN either.

    A NaN reaching the output survives `depth > 0` (False) but would poison the median and the
    percentile if it were included; sending it to the far plane keeps the array finite so the
    caller's `isfinite` filter is the only thing that has to drop it.
    """
    depth = np.array([[2.0, 4.0, 0.0, -1.0, np.nan]], dtype=np.float32)
    out = normalize_metric_depth(depth, depth_range=8.0)
    assert np.isfinite(out).all()
    assert out[0, 0] == pytest.approx(1.0, abs=0.01), "the near percentile anchors at 1"
    assert out[0, 1] > out[0, 0]
    assert np.allclose(out[0, 2:], 8.0), "invalid samples go to the far plane, not the near one"


# ── the file the writer actually produces ─────────────────────────────────────────────────

def test_an_empty_cloud_writes_a_structurally_valid_zero_vertex_ply(tmp_path: Path):
    """A header claiming N vertices with no body is the classic way to corrupt a viewer."""
    out = tmp_path / "empty.ply"
    empty3 = np.zeros((0, 3), dtype=np.float32)
    write_gaussian_ply(out, empty3, empty3, empty3, np.zeros((0,), dtype=np.float32))

    raw = out.read_bytes()
    header, _, body = raw.partition(b"end_header\n")
    assert b"element vertex 0\n" in header
    assert body == b""
    assert read_gaussian_ply(out).count == 0


def test_the_body_length_matches_the_declared_vertex_count(tmp_path: Path):
    """The one invariant every downstream parser trusts, checked at the byte level."""
    img = tmp_path / "in.png"
    Image.new("RGB", (37, 23), (90, 140, 60)).save(img)
    out = tmp_path / "master.ply"
    count = depth_image_to_gaussian_ply(
        img, np.tile(np.linspace(1.0, 4.0, 37, dtype=np.float32), (23, 1)), out,
        edge_drop_percent=0.0,
    )
    header, _, body = out.read_bytes().partition(b"end_header\n")
    assert f"element vertex {count}\n".encode() in header
    assert len(body) == count * PLY_FIELDS * 4


def test_opacity_and_scale_extremes_stay_finite_through_the_logit_and_the_log(tmp_path: Path):
    """opacity=1 is logit(1)=+inf and scale=0 is log(0)=-inf without the epsilon clamps.

    An inf or NaN in the vertex buffer is not a visual glitch — SuperSplat and Spark both drop
    or mis-sort the whole cloud, so the asset reads as "the engine produced nothing".
    """
    out = tmp_path / "extremes.ply"
    xyz = np.zeros((3, 3), dtype=np.float32)
    rgb01 = np.zeros((3, 3), dtype=np.float32)
    scales = np.array([[0.0, 0.0, 0.0], [1e-30, 1.0, 1e30], [1.0, 1.0, 1.0]], dtype=np.float32)
    opacity = np.array([0.0, 1.0, 0.5], dtype=np.float32)
    write_gaussian_ply(out, xyz, rgb01, scales, opacity)

    cloud = read_gaussian_ply(out)
    assert np.isfinite(cloud.opacity_logit).all()
    assert np.isfinite(cloud.log_scales).all()
    assert cloud.opacity_logit[0] < 0 < cloud.opacity_logit[1], "0 and 1 must not collapse"
    assert cloud.opacity_logit[2] == pytest.approx(0.0, abs=1e-5)


def test_colour_outside_the_unit_range_is_clipped_not_wrapped(tmp_path: Path):
    """f_dc is an unbounded float, so an out-of-range colour writes a real (wrong) value."""
    out = tmp_path / "colors.ply"
    xyz = np.zeros((2, 3), dtype=np.float32)
    rgb01 = np.array([[-4.0, -4.0, -4.0], [4.0, 4.0, 4.0]], dtype=np.float32)
    write_gaussian_ply(
        out, xyz, rgb01, np.ones((2, 3), dtype=np.float32), np.full(2, 0.5, dtype=np.float32)
    )
    f_dc = read_gaussian_ply(out).f_dc
    assert np.allclose(f_dc[0], (0.0 - 0.5) / SH_C0, rtol=1e-5)
    assert np.allclose(f_dc[1], (1.0 - 0.5) / SH_C0, rtol=1e-5)
