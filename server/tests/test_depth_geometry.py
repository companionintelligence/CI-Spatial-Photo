"""Depth-map maths: normalisation, back-projection, edge rejection, PLY output.

Pure numpy — no torch, no weights, no network. This is the half of the depth engines that
actually determines whether the result looks like a scene or like a crumpled sheet, so it is
tested directly rather than through a mocked model.
"""

from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from app.plywriter import (
    depth_image_to_gaussian_ply,
    depth_to_gaussian_cloud,
    disparity_to_depth,
    image_to_flat_gaussian_ply,
    normalize_metric_depth,
)
from app.transcode import read_gaussian_ply


# ── disparity → depth ─────────────────────────────────────────────────────────────────────

def test_disparity_inverts_and_spans_the_configured_range():
    disparity = np.linspace(0.0, 1.0, 256, dtype=np.float32).reshape(16, 16)
    depth = disparity_to_depth(disparity, depth_range=8.0)
    # High disparity means near, so depth must decrease as disparity increases.
    flat_d, flat_z = disparity.ravel(), depth.ravel()
    assert flat_z[flat_d.argmax()] < flat_z[flat_d.argmin()]
    assert depth.min() == pytest.approx(1.0, abs=0.02)
    assert depth.max() == pytest.approx(8.0, abs=0.05)


def test_disparity_mapping_is_inverse_not_linear():
    """The midpoint of the disparity range must land nearer than the midpoint of the depth range.

    A linear map (the obvious wrong implementation) would put it at 4.5 and spend the whole
    depth budget on the background, flattening every subject into a bas-relief. Inverting puts
    the mid-disparity plane at 2/(1+1/8) ~= 1.78.
    """
    disparity = np.linspace(0.0, 1.0, 101, dtype=np.float32).reshape(1, 101)
    depth = disparity_to_depth(disparity, depth_range=8.0)
    assert depth[0, 50] < 2.5


def test_disparity_outliers_do_not_flatten_the_scene():
    """One hot pixel must not compress everything else into a plane."""
    disparity = np.tile(np.linspace(0.0, 1.0, 32, dtype=np.float32), (32, 1))
    clean = disparity_to_depth(disparity.copy(), depth_range=8.0)
    disparity[0, 0] = 1e6  # a blown-out sky pixel / lens flare
    with_outlier = disparity_to_depth(disparity, depth_range=8.0)
    # Ignore the outlier pixel itself; the rest of the frame must keep its full depth spread.
    assert np.ptp(with_outlier[1:, :]) == pytest.approx(np.ptp(clean[1:, :]), rel=0.05)


def test_constant_disparity_degrades_to_a_plane_not_to_nan():
    depth = disparity_to_depth(np.full((8, 8), 0.5, dtype=np.float32))
    assert np.isfinite(depth).all()
    assert np.allclose(depth, depth.flat[0])


def test_disparity_with_no_finite_values_raises():
    with pytest.raises(ValueError):
        disparity_to_depth(np.full((4, 4), np.nan, dtype=np.float32))


def test_metric_depth_is_clamped_but_keeps_relative_structure():
    depth = np.array([[0.5, 1.0, 2.0, 10_000.0]], dtype=np.float32)  # last = the horizon
    out = normalize_metric_depth(depth, depth_range=8.0)
    assert out.min() >= 1.0 and out.max() <= 8.0
    assert out[0, 1] < out[0, 2]  # 1 m still nearer than 2 m after rescaling


# ── back-projection ───────────────────────────────────────────────────────────────────────

def _rgb(h: int, w: int) -> np.ndarray:
    return np.full((h, w, 3), 128, dtype=np.uint8)


def test_constant_depth_reproduces_the_preview_engine_framing():
    """A flat depth map must land exactly where the Preview engine puts its plane.

    This is the property that lets a user switch a job from `preview` to `depth-image` without
    the viewer's default camera suddenly clipping into the asset or leaving it a distant speck.
    """
    h, w = 48, 64
    xyz, _, _, _ = depth_to_gaussian_cloud(
        _rgb(h, w), np.ones((h, w), dtype=np.float32), fov_deg=60.0, edge_drop_percent=0.0
    )
    aspect = w / h
    assert np.allclose(xyz[:, 2], 0.0, atol=1e-5)
    assert xyz[:, 0].max() == pytest.approx(aspect, rel=0.02)
    assert xyz[:, 0].min() == pytest.approx(-aspect, rel=0.02)
    assert xyz[:, 1].max() == pytest.approx(1.0, rel=0.03)


def test_near_region_is_pushed_toward_the_viewer():
    """The whole point of the engine: nearer depth must become nearer geometry.

    The cloud is centred on the *median* depth, so a small subject against a large backdrop
    puts the backdrop at z = 0 and the subject in front of it — the subject does not straddle
    zero, and asserting that it does would be asserting the wrong model of the normalisation.
    """
    h, w = 40, 40
    depth = np.full((h, w), 4.0, dtype=np.float32)
    depth[12:28, 12:28] = 1.0  # a subject in front of a backdrop
    xyz, _, _, _ = depth_to_gaussian_cloud(_rgb(h, w), depth, edge_drop_percent=0.0)
    z = xyz[:, 2]
    assert int((z > 1e-4).sum()) == 16 * 16, "exactly the subject pixels move toward the viewer"
    assert z.min() == pytest.approx(0.0, abs=1e-5), "the backdrop is the median plane"
    assert np.ptp(z) > 0.5, "a 4:1 depth ratio must produce visible parallax, not a near-plane"


def test_depth_spread_straddles_zero_when_the_scene_is_balanced():
    """With as much foreground as background, the cloud is centred: content on both sides."""
    h, w = 40, 40
    depth = np.full((h, w), 5.0, dtype=np.float32)
    depth[:20, :] = 1.0  # half near, half far -> the median lands between them
    xyz, _, _, _ = depth_to_gaussian_cloud(_rgb(h, w), depth, edge_drop_percent=0.0)
    z = xyz[:, 2]
    assert z.max() > 0.0 and z.min() < 0.0


def test_splat_radius_grows_with_depth():
    """Constant-radius Gaussians leave holes in the background; the footprint must scale."""
    h, w = 32, 64
    depth = np.tile(np.linspace(1.0, 8.0, w, dtype=np.float32), (h, 1))
    xyz, _, scales, _ = depth_to_gaussian_cloud(_rgb(h, w), depth, edge_drop_percent=0.0)
    far = scales[xyz[:, 2].argmin(), 0]
    near = scales[xyz[:, 2].argmax(), 0]
    assert far > near * 2


def test_edge_rejection_removes_the_occlusion_boundary():
    """Pixels straddling a depth step become a stretched sheet; they must be dropped."""
    h, w = 40, 40
    depth = np.full((h, w), 6.0, dtype=np.float32)
    depth[:, 20:] = 1.0
    kept_all, _, _, _ = depth_to_gaussian_cloud(_rgb(h, w), depth, edge_drop_percent=0.0)
    kept_trimmed, _, _, _ = depth_to_gaussian_cloud(_rgb(h, w), depth, edge_drop_percent=10.0)
    assert kept_trimmed.shape[0] < kept_all.shape[0]
    # Nothing should survive strictly between the two planes.
    z_values = np.unique(np.round(kept_trimmed[:, 2], 4))
    assert len(z_values) == 2, f"expected two clean planes, got {len(z_values)} z levels"


def test_max_points_downsamples_instead_of_truncating():
    h, w = 200, 200
    depth = np.linspace(1.0, 4.0, h * w, dtype=np.float32).reshape(h, w)
    xyz, rgb01, _, _ = depth_to_gaussian_cloud(
        _rgb(h, w), depth, max_points=2_000, edge_drop_percent=0.0
    )
    assert xyz.shape[0] <= 2_000
    assert rgb01.shape[0] == xyz.shape[0]
    # Downsampled, not cropped: the full depth span must still be represented.
    assert np.ptp(xyz[:, 2]) > 0.5


def test_focal_length_overrides_the_assumed_field_of_view():
    """Depth Pro's predicted focal must actually change the geometry, or it is decoration."""
    h, w = 40, 60
    depth = np.linspace(1.0, 3.0, h * w, dtype=np.float32).reshape(h, w)
    assumed, _, _, _ = depth_to_gaussian_cloud(_rgb(h, w), depth, fov_deg=60.0)
    # A long lens: much larger focal in pixels than (w/2)/tan(30 deg) ~= 52.
    telephoto, _, _, _ = depth_to_gaussian_cloud(_rgb(h, w), depth, fov_deg=60.0, focal_px=400.0)
    assert np.ptp(telephoto[:, 2]) != pytest.approx(np.ptp(assumed[:, 2]), rel=0.05)


def test_mismatched_shapes_raise():
    with pytest.raises(ValueError):
        depth_to_gaussian_cloud(_rgb(10, 10), np.ones((8, 8), dtype=np.float32))


def test_all_invalid_depth_raises():
    with pytest.raises(ValueError):
        depth_to_gaussian_cloud(_rgb(8, 8), np.zeros((8, 8), dtype=np.float32))


# ── end-to-end file output ────────────────────────────────────────────────────────────────

def test_depth_ply_is_readable_and_not_flat(tmp_path: Path):
    img = tmp_path / "in.png"
    Image.new("RGB", (64, 48), (200, 80, 40)).save(img)
    depth = np.tile(np.linspace(1.0, 5.0, 64, dtype=np.float32), (48, 1))

    out = tmp_path / "depth.ply"
    count = depth_image_to_gaussian_ply(img, depth, out, edge_drop_percent=0.0)
    assert count > 0

    cloud = read_gaussian_ply(out)
    assert cloud.count == count
    assert np.isfinite(cloud.positions).all()
    assert np.isfinite(cloud.log_scales).all()
    assert np.allclose(cloud.rotations[:, 0], 1.0)  # identity quaternion, as the writer promises

    flat = tmp_path / "flat.ply"
    image_to_flat_gaussian_ply(img, flat, max_dim=64)
    flat_cloud = read_gaussian_ply(flat)
    # The whole justification for this engine over Preview.
    assert np.ptp(cloud.positions[:, 2]) > 0.5
    assert np.ptp(flat_cloud.positions[:, 2]) == pytest.approx(0.0, abs=1e-6)


def test_depth_is_resampled_to_the_source_image_resolution(tmp_path: Path):
    """Depth heads run at their own fixed input size; the colour resolution must win."""
    img = tmp_path / "in.png"
    Image.new("RGB", (80, 60), (10, 220, 90)).save(img)
    coarse = np.tile(np.linspace(1.0, 4.0, 20, dtype=np.float32), (15, 1))  # 15x20, not 60x80
    out = tmp_path / "depth.ply"
    count = depth_image_to_gaussian_ply(img, coarse, out, edge_drop_percent=0.0)
    assert count == 80 * 60


def test_edge_mask_survives_a_single_nan_depth_pixel():
    """One bad pixel must cost a pixel, not the whole job.

    `np.percentile` over an array containing a single NaN returns NaN, and
    `mag <= nan` is False for every element — so an unguarded percentile turned
    one NaN in the depth map into an all-false mask, i.e. zero Gaussians and a
    failed job. Depth models do emit NaN (fp16 overflow, degenerate patches).
    """
    from app.plywriter import _edge_mask

    depth = np.linspace(1.0, 5.0, 64, dtype=np.float32).reshape(8, 8)
    clean = _edge_mask(depth, 5.0).sum()

    poisoned = depth.copy()
    poisoned[3, 3] = np.nan
    kept = _edge_mask(poisoned, 5.0).sum()

    assert kept > 0, "a single NaN rejected the entire frame"
    # Only the neighbours whose central difference straddles the NaN are lost.
    # Not the NaN pixel itself: np.gradient computes a pixel's gradient from its
    # NEIGHBOURS, so the contamination lands beside the NaN, not on it. Dropping
    # the NaN sample is the caller's job and it already does it —
    # `np.isfinite(depth) & (depth > 0) & _edge_mask(...)` at the back-projection
    # site — which is asserted below rather than duplicated in the edge mask.
    assert clean - kept <= 8

    valid = np.isfinite(poisoned) & (poisoned > 0) & _edge_mask(poisoned, 5.0)
    assert not valid[3, 3], "the NaN sample must not reach back-projection"
    assert valid.sum() > 0


def test_edge_mask_keeps_everything_when_no_gradient_is_finite():
    """An all-NaN map has nothing to rank, so it must not silently return empty.

    Returning all-false here would surface as "the model saw nothing but edges";
    keeping the frame lets the caller's own validation raise the real error.
    """
    from app.plywriter import _edge_mask

    assert _edge_mask(np.full((8, 8), np.nan, dtype=np.float32), 5.0).all()
