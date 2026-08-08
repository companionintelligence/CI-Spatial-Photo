"""The two depth engines: gating, model selection, routing, and a real end-to-end run.

The neural network is the only thing mocked. Everything downstream of it — normalisation,
back-projection, edge rejection, temporal alignment, anchor-frame choice, PLY writing — is the
production code path, so these tests fail if the geometry breaks and not only if the plumbing
does. Nothing here imports torch, and no weights are fetched.
"""

import shutil
import stat
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from app.config import Settings
from app.engines import depth_backend, depth_models as catalog
from app.engines.base import EngineError
from app.engines.depth_image import DepthImageEngine
from app.engines.depth_video import (
    DepthVideoEngine,
    align_sequence,
    camera_is_static,
    fit_scale_shift,
    frame_sharpness,
    sample_evenly,
)
from app.engines.registry import EngineRegistry, split_engine_ref
from app.models import JobInput


def _settings(**kw) -> Settings:
    base = dict(auth_disabled=True, sharp_enable_research=False, default_engine="triposplat")
    base.update(kw)
    return Settings(**base)


def _ramp_disparity(size: tuple[int, int]) -> np.ndarray:
    """A left-to-right disparity gradient — a stand-in for "the model saw a receding scene"."""
    w, h = size
    return np.tile(np.linspace(1.0, 0.0, w, dtype=np.float32), (h, 1))


@pytest.fixture()
def fake_depth_model(monkeypatch):
    """Make the depth deps look installed and replace inference with a synthetic ramp."""
    monkeypatch.setattr(catalog, "missing_python_deps", lambda: [])
    monkeypatch.setattr(catalog, "downloads_disabled", lambda: False)

    calls: list[str] = []

    def fake_predict(image, spec, settings):
        calls.append(spec.id)
        return depth_backend.DepthPrediction(
            values=_ramp_disparity(image.size), kind=spec.kind, focal_px=None
        )

    monkeypatch.setattr(depth_backend, "predict_depth", fake_predict)
    return calls


@pytest.fixture()
def ffmpeg_present(monkeypatch):
    """Pretend ffmpeg is installed so video availability does not depend on the host."""
    real_which = shutil.which
    monkeypatch.setattr(
        shutil, "which", lambda cmd, *a, **kw: "/usr/bin/ffmpeg" if cmd == "ffmpeg"
        else real_which(cmd, *a, **kw)
    )


# ── availability with nothing installed (the CI machine) ──────────────────────────────────

def test_depth_image_unavailable_without_torch_and_says_how_to_fix_it():
    available, reason = DepthImageEngine().is_available(_settings())
    if catalog.missing_python_deps():
        assert available is False
        assert "[depth]" in reason and "pip install" in reason
    else:  # a dev box that happens to have torch — the engine must then work, not half-work
        assert available is True


def test_capabilities_never_raise_and_keep_the_original_contract():
    """`GET /engines` must survive a machine with no torch, no weights and no network."""
    caps = DepthImageEngine().capabilities(_settings())
    for field in ("name", "description", "inputs", "intents", "output_kind", "output_formats",
                  "commercial", "requires_gpu", "license", "available"):
        assert hasattr(caps, field)
    assert caps.inputs == ["image"]
    assert len(caps.models) == len(catalog.IMAGE_MODELS)


def test_run_refuses_cleanly_when_deps_are_missing(monkeypatch, tmp_path):
    monkeypatch.setattr(catalog, "missing_python_deps", lambda: ["torch", "transformers"])
    img = tmp_path / "a.png"
    Image.new("RGB", (16, 16)).save(img)
    ji = JobInput(owner="u", source_type="image", files=[img])
    with pytest.raises(EngineError, match="depth"):
        DepthImageEngine().run(ji, tmp_path, _settings())


# ── model selection ───────────────────────────────────────────────────────────────────────

def test_default_model_is_the_permissive_one(fake_depth_model):
    settings = _settings()
    engine = DepthImageEngine()
    assert engine.resolve_model(JobInput(owner="u", source_type="image"), settings) == \
        "depth-anything-v2-small"


def test_requested_model_is_honoured(fake_depth_model):
    engine = DepthImageEngine()
    ji = JobInput(owner="u", source_type="image", requested_model="midas-dpt-large")
    assert engine.resolve_model(ji, _settings()) == "midas-dpt-large"


def test_unknown_model_raises_before_any_work_happens(fake_depth_model):
    ji = JobInput(owner="u", source_type="image", requested_model="nope")
    with pytest.raises(EngineError, match="Unknown model"):
        DepthImageEngine().resolve_model(ji, _settings())


def test_capabilities_expose_per_model_availability(fake_depth_model):
    caps = DepthImageEngine().capabilities(_settings())
    by_id = {m.id: m for m in caps.models}
    assert by_id["depth-anything-v2-small"].available is True
    assert by_id["depth-anything-v2-large"].available is False
    assert by_id["depth-anything-v2-large"].approx_download_mb > 1000
    assert caps.default_model == "depth-anything-v2-small"
    # Engine-level availability must not be dragged down by a licence-gated entry.
    assert caps.available is True


# ── end-to-end image run ──────────────────────────────────────────────────────────────────

def test_image_run_writes_a_parallax_ply(fake_depth_model, tmp_path):
    from app.transcode import read_gaussian_ply

    img = tmp_path / "photo.png"
    Image.new("RGB", (64, 48), (30, 140, 210)).save(img)
    ji = JobInput(owner="u", source_type="image", files=[img],
                  requested_model="midas-dpt-hybrid")

    result = DepthImageEngine().run(ji, tmp_path, _settings())

    assert fake_depth_model == ["midas-dpt-hybrid"], "the requested checkpoint must be the one run"
    assert result.kind == "splat" and result.master_format == "ply"
    cloud = read_gaussian_ply(result.master_path)
    assert cloud.count > 0
    assert np.ptp(cloud.positions[:, 2]) > 0.5, "output must have depth, not be a flat plane"
    assert result.thumbnail_path is not None and result.thumbnail_path.exists()


def test_degenerate_prediction_becomes_an_engine_error_not_a_crash(monkeypatch, tmp_path):
    monkeypatch.setattr(catalog, "missing_python_deps", lambda: [])
    monkeypatch.setattr(
        depth_backend, "predict_depth",
        lambda image, spec, settings: depth_backend.DepthPrediction(
            values=np.full((8, 8), np.nan, dtype=np.float32), kind="relative"
        ),
    )
    img = tmp_path / "photo.png"
    Image.new("RGB", (16, 16)).save(img)
    ji = JobInput(owner="u", source_type="image", files=[img])
    with pytest.raises(EngineError, match="unusable"):
        DepthImageEngine().run(ji, tmp_path, _settings())


# ── video sequence maths ──────────────────────────────────────────────────────────────────

def test_fit_scale_shift_recovers_a_known_transform():
    rng = np.random.default_rng(0)
    source = rng.normal(size=(32, 32)).astype(np.float32)
    target = source * 2.5 - 0.75
    a, b = fit_scale_shift(source, target)
    assert a == pytest.approx(2.5, rel=0.02)
    assert b == pytest.approx(-0.75, abs=0.05)


def test_fit_survives_a_constant_frame_without_dividing_by_zero():
    a, b = fit_scale_shift(np.zeros((8, 8)), np.full((8, 8), 3.0))
    assert np.isfinite(a) and np.isfinite(b)


def test_align_sequence_removes_the_per_frame_normalisation_breathing():
    """Independently normalised frames make the scene pulse; alignment must flatten that out."""
    rng = np.random.default_rng(1)
    base = rng.normal(size=(24, 24)).astype(np.float32)
    frames = [base * s + o for s, o in ((1.0, 0.0), (3.0, 5.0), (0.2, -2.0), (7.0, 1.0))]
    spans_before = [float(np.ptp(f)) for f in frames]
    assert max(spans_before) / min(spans_before) > 10  # they really are wildly inconsistent

    aligned = align_sequence(frames)
    spans_after = [float(np.ptp(f)) for f in aligned]
    assert max(spans_after) / min(spans_after) == pytest.approx(1.0, abs=0.02)


def test_align_sequence_is_a_no_op_for_one_frame():
    frame = np.arange(16, dtype=np.float32).reshape(4, 4)
    assert np.allclose(align_sequence([frame])[0], frame)
    assert align_sequence([]) == []


def test_frame_sharpness_ranks_a_blurred_frame_lower():
    from PIL import ImageFilter

    rng = np.random.default_rng(2)
    sharp = (rng.random((64, 64)) * 255).astype(np.uint8)
    blurred = np.asarray(Image.fromarray(sharp).filter(ImageFilter.GaussianBlur(3)))
    assert frame_sharpness(sharp) > frame_sharpness(blurred) * 5


def test_camera_is_static_distinguishes_a_tripod_from_a_pan():
    rng = np.random.default_rng(3)
    base = rng.random((32, 32)).astype(np.float32)
    tripod = [base + rng.normal(scale=0.002, size=base.shape).astype(np.float32) for _ in range(4)]
    panning = [np.roll(base, shift * 6, axis=1) for shift in range(4)]
    assert camera_is_static(tripod) is True
    assert camera_is_static(panning) is False
    assert camera_is_static([base]) is False


def test_sample_evenly_spans_the_whole_clip():
    items = [Path(f"f{i}.jpg") for i in range(100)]
    picked = sample_evenly(items, 5)
    assert len(picked) == 5
    assert picked[0] == items[0] and picked[-1] == items[-1]
    assert sample_evenly(items, 0) == items          # 0 = no cap
    assert sample_evenly(items[:3], 10) == items[:3]  # fewer than the cap


# ── end-to-end video run ──────────────────────────────────────────────────────────────────

def _write_frames(dirpath: Path, n: int, size=(48, 36), jitter: int = 0) -> list[Path]:
    dirpath.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(7)
    base = (rng.random((size[1], size[0], 3)) * 255).astype(np.uint8)
    out = []
    for i in range(n):
        arr = np.roll(base, i * jitter, axis=1) if jitter else base
        p = dirpath / f"frame_{i:05d}.jpg"
        Image.fromarray(arr).save(p, quality=95)
        out.append(p)
    return out


def test_video_run_uses_the_sharpest_frame_and_writes_a_ply(
    monkeypatch, fake_depth_model, ffmpeg_present, tmp_path
):
    from app.transcode import read_gaussian_ply

    frames = _write_frames(tmp_path / "frames", 5, jitter=4)
    # Flatten every frame but one. The survivor is the only frame with any texture, so it is
    # unambiguously the sharpest — and because a flat frame carries no colour variation, the
    # colours in the output PLY prove which frame the engine actually back-projected.
    flat = np.full((36, 48, 3), 128, dtype=np.uint8)
    for i, p in enumerate(frames):
        if i != 3:
            Image.fromarray(flat).save(p, quality=95)

    monkeypatch.setattr(DepthVideoEngine, "_extract_frames", lambda self, v, d, s: frames)
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"not really a video; ffmpeg is mocked out")

    ji = JobInput(owner="u", source_type="video", files=[video],
                  requested_model="depth-anything-v2-small")
    result = DepthVideoEngine().run(ji, tmp_path, _settings())

    assert len(fake_depth_model) == len(frames), "every sampled frame must be predicted"
    cloud = read_gaussian_ply(result.master_path)
    assert cloud.count > 0 and np.ptp(cloud.positions[:, 2]) > 0.5
    assert cloud.f_dc.std() > 0.05, "the flat frames won; the sharpest frame was not chosen"
    assert result.temporal is False, "single-frame output; do not claim a 4D asset"


def test_video_engine_reports_the_missing_cli_for_vda_models(ffmpeg_present, fake_depth_model):
    caps = DepthVideoEngine().capabilities(_settings())
    by_id = {m.id: m for m in caps.models}
    assert by_id["video-depth-anything-small"].available is False
    assert "VIDEO_DEPTH_CMD" in by_id["video-depth-anything-small"].unavailable_reason
    # ...but the per-frame path keeps the engine usable.
    assert by_id["depth-anything-v2-small"].available is True
    assert caps.available is True


def test_requesting_a_vda_model_without_the_cli_fails_loudly(ffmpeg_present, fake_depth_model):
    ji = JobInput(owner="u", source_type="video", requested_model="video-depth-anything-small")
    with pytest.raises(EngineError, match="VIDEO_DEPTH_CMD"):
        DepthVideoEngine().resolve_model(ji, _settings())


def test_external_cli_adapter_reads_back_a_depth_sequence(
    monkeypatch, ffmpeg_present, tmp_path
):
    """Exercise the Video Depth Anything subprocess contract with a stand-in binary.

    The adapter's riskiest assumption is that the CLI's frame count need not match ours, so the
    stub deliberately emits a different count at a different resolution.
    """
    from app.engines import depth_video
    from app.transcode import read_gaussian_ply

    stub = tmp_path / "fake-vda"
    stub.write_text(
        f"#!{sys.executable}\n"
        "import argparse, pathlib, numpy as np\n"
        "p = argparse.ArgumentParser()\n"
        "p.add_argument('--input'); p.add_argument('--output'); p.add_argument('--encoder')\n"
        "a = p.parse_args()\n"
        "out = pathlib.Path(a.output); out.mkdir(parents=True, exist_ok=True)\n"
        "assert a.encoder == 'vits', a.encoder\n"
        # 11 frames at 24x18 vs the 4 RGB frames at 48x36 the engine decoded.
        "for i in range(11):\n"
        "    ramp = np.tile(np.linspace(1.0, 0.0, 24, dtype=np.float32), (18, 1))\n"
        "    np.save(out / f'depth_{i:05d}.npy', ramp)\n"
    )
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    monkeypatch.setattr(depth_video, "VIDEO_DEPTH_CMD", str(stub))

    frames = _write_frames(tmp_path / "frames", 4)
    monkeypatch.setattr(DepthVideoEngine, "_extract_frames", lambda self, v, d, s: frames)
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"stub")

    ji = JobInput(owner="u", source_type="video", files=[video],
                  requested_model="video-depth-anything-small")
    result = DepthVideoEngine().run(ji, tmp_path, _settings())
    cloud = read_gaussian_ply(result.master_path)
    assert cloud.count > 0 and np.ptp(cloud.positions[:, 2]) > 0.5


def test_external_cli_failure_surfaces_its_stderr(monkeypatch, ffmpeg_present, tmp_path):
    from app.engines import depth_video

    stub = tmp_path / "broken-vda"
    stub.write_text(f"#!{sys.executable}\nimport sys; sys.stderr.write('CUDA out of memory'); "
                    "sys.exit(1)\n")
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setattr(depth_video, "VIDEO_DEPTH_CMD", str(stub))

    frames = _write_frames(tmp_path / "frames", 2)
    monkeypatch.setattr(DepthVideoEngine, "_extract_frames", lambda self, v, d, s: frames)
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"stub")

    ji = JobInput(owner="u", source_type="video", files=[video],
                  requested_model="video-depth-anything-small")
    with pytest.raises(EngineError, match="CUDA out of memory"):
        DepthVideoEngine().run(ji, tmp_path, _settings())


def test_the_stub_binary_is_actually_executable(tmp_path):
    """Guard the guard: a stub that silently is not runnable would make the CLI tests vacuous."""
    stub = tmp_path / "echo-stub"
    stub.write_text(f"#!{sys.executable}\nprint('ok')\n")
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
    assert subprocess.run([str(stub)], capture_output=True, text=True).stdout.strip() == "ok"


# ── router integration ────────────────────────────────────────────────────────────────────

def test_app_startup_never_imports_torch():
    """The constraint the whole lazy-import dance exists to satisfy.

    `registry.py` instantiates every engine at import time and `create_app` builds the
    capability list during startup. A single top-level `import torch` anywhere in that chain
    turns "the optional extra is not installed" into "the API will not boot" — and on a machine
    where torch *is* installed it adds seconds to startup and hundreds of megabytes of RSS to a
    process that may never run a depth job.

    Run in a subprocess so the assertion is about a fresh interpreter and cannot be polluted by
    whatever the rest of the test session has imported.
    """
    probe = (
        "import sys\n"
        "from app.main import app\n"
        "from app.config import Settings\n"
        "from app.engines.registry import get_registry\n"
        "get_registry().capabilities(Settings())\n"
        "print(','.join(m for m in ('torch', 'transformers', 'torchvision') if m in sys.modules))\n"
    )
    proc = subprocess.run(
        [sys.executable, "-c", probe],
        cwd=Path(__file__).resolve().parent.parent,
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr
    loaded = proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else ""
    assert loaded == "", f"app startup eagerly imported: {loaded}"


def test_split_engine_ref():
    assert split_engine_ref("depth-image:midas-dpt-large") == ("depth-image", "midas-dpt-large")
    assert split_engine_ref("preview") == ("preview", None)
    assert split_engine_ref(None) == (None, None)
    assert split_engine_ref("depth-image:") == ("depth-image", None)


def test_registry_registers_both_depth_engines():
    names = {c.name for c in EngineRegistry().capabilities(_settings())}
    assert {"depth-image", "depth-video"} <= names
    # The originals must survive untouched.
    assert {"preview", "triposplat", "sharp", "photogrammetry"} <= names


def test_default_routing_is_unchanged_by_the_new_engines(fake_depth_model):
    """Even with the depth deps present, automatic routing must not silently move."""
    reg = EngineRegistry()
    ji = JobInput(owner="u", source_type="image", files=[Path("a.jpg")])
    assert reg.route(ji, _settings()).name == "preview"


def test_depth_auto_route_opts_into_the_better_fallback(fake_depth_model):
    reg = EngineRegistry()
    ji = JobInput(owner="u", source_type="image", files=[Path("a.jpg")])
    assert reg.route(ji, _settings(depth_auto_route=True)).name == "depth-image"


def test_default_engine_setting_selects_depth(fake_depth_model):
    reg = EngineRegistry()
    ji = JobInput(owner="u", source_type="image", files=[Path("a.jpg")])
    assert reg.route(ji, _settings(default_engine="depth-image")).name == "depth-image"


def test_video_auto_route_reaches_depth_video(fake_depth_model, ffmpeg_present):
    reg = EngineRegistry()
    ji = JobInput(owner="u", source_type="video", files=[Path("v.mp4")])
    with pytest.raises(EngineError):  # photogrammetry missing, flag off -> unchanged behaviour
        reg.route(ji, _settings())
    assert reg.route(ji, _settings(depth_auto_route=True)).name == "depth-video"


def test_engine_colon_model_shorthand_is_normalised_onto_the_job(fake_depth_model):
    reg = EngineRegistry()
    ji = JobInput(owner="u", source_type="image", files=[Path("a.jpg")],
                  requested_engine="depth-image:midas-dpt-hybrid")
    engine = reg.route(ji, _settings())
    assert engine.name == "depth-image"
    assert ji.requested_engine == "depth-image"
    assert ji.requested_model == "midas-dpt-hybrid"


def test_explicit_model_field_beats_the_shorthand(fake_depth_model):
    reg = EngineRegistry()
    ji = JobInput(owner="u", source_type="image", files=[Path("a.jpg")],
                  requested_engine="depth-image:midas-dpt-hybrid",
                  requested_model="midas-dpt-large")
    reg.route(ji, _settings())
    assert ji.requested_model == "midas-dpt-large"


def test_router_rejects_a_bad_model_at_submission_time(fake_depth_model):
    reg = EngineRegistry()
    ji = JobInput(owner="u", source_type="image", files=[Path("a.jpg")],
                  requested_engine="depth-image", requested_model="totally-made-up")
    with pytest.raises(EngineError, match="Unknown model"):
        reg.route(ji, _settings())


def test_requesting_depth_image_without_deps_reports_the_install_hint(monkeypatch):
    monkeypatch.setattr(catalog, "missing_python_deps", lambda: ["torch"])
    reg = EngineRegistry()
    ji = JobInput(owner="u", source_type="image", files=[Path("a.jpg")],
                  requested_engine="depth-image")
    with pytest.raises(EngineError, match=r"\[depth\]"):
        reg.route(ji, _settings())


def test_job_manager_records_which_checkpoint_ran(fake_depth_model, tmp_path):
    """"Made with depth-image" is not reproducible information; the model id has to persist."""
    import asyncio

    from app.jobs import JobManager
    from app.storage import Store

    img = tmp_path / "cat.jpg"
    Image.new("RGB", (48, 36), (200, 100, 50)).save(img)
    settings = _settings(asset_dir=tmp_path / "assets", ci_memory_mcp_url="")
    store = Store(settings.asset_dir)
    manager = JobManager(store, settings)

    async def drive():
        job = manager.create_job(JobInput(
            owner="dev@local", source_type="image", files=[img], original_filenames=["cat.jpg"],
            requested_engine="depth-image", requested_model="midas-dpt-hybrid",
        ))
        for _ in range(400):
            current = store.get_job(job.job_id)
            if current and current.status in ("done", "error"):
                return current
            await asyncio.sleep(0.02)
        raise TimeoutError("job did not finish")

    finished = asyncio.run(drive())
    assert finished.status == "done", finished.error
    assert finished.engine == "depth-image"
    asset = store.get_asset(finished.asset_id)
    assert asset.engine_model == "midas-dpt-hybrid"
    assert "midas-dpt-hybrid" in asset.tags


def test_single_model_engines_still_report_no_model(fake_depth_model):
    reg = EngineRegistry()
    settings = _settings()
    for name in ("preview", "triposplat", "sharp", "photogrammetry"):
        engine = reg.get(name)
        assert engine.available_models(settings) == []
        assert engine.resolve_model(JobInput(owner="u", source_type="image"), settings) is None


# ── advertised default vs executed default ────────────────────────────────────


def _job(**kw) -> JobInput:
    base = dict(owner="t", source_type="image", files=[Path("a.png")])
    base.update(kw)
    return JobInput(**base)


@pytest.mark.parametrize(
    "configured",
    ["depth-anything-v2-small", "depth-anything-v2-base", "depth-anything-v2-large", "depth-pro"],
)
def test_image_default_model_is_the_one_an_unspecified_job_runs(
    fake_depth_model, monkeypatch, configured
):
    """`default_model` is a promise about behaviour, not a label.

    docs/API.md defines it as "the models[].id a job with no `model` field would
    run", and the Create panel prints that checkpoint's licence and GPU need. It
    used to be re-derived as "first available in catalog order", which ignores
    DEPTH_MODEL — so a box configured for Large advertised Small's Apache-2.0
    licence for a job that would pull CC-BY-NC weights.
    """
    engine = DepthImageEngine()
    settings = _settings(depth_model=configured, depth_allow_noncommercial=True)
    assert engine.capabilities(settings).default_model == engine.resolve_model(_job(), settings)


def test_video_default_model_is_the_one_an_unspecified_job_runs(fake_depth_model, monkeypatch):
    """Same contract for the video engine, where the stock config already broke it.

    VIDEO_MODELS lists the external-CLI checkpoints first, so on any box with the
    CLI installed the old derivation advertised `video-depth-anything-small`
    (temporal, GPU) while an unspecified job ran the per-frame CPU fallback —
    the engine promising its whole selling point and delivering the fallback.
    """
    engine = DepthVideoEngine()
    monkeypatch.setattr(engine, "_cli", lambda: "/usr/local/bin/video-depth-anything")
    settings = _settings()
    job = _job(source_type="video", files=[Path("a.mp4")])
    assert engine.capabilities(settings).default_model == engine.resolve_model(job, settings)


def test_default_model_is_null_when_nothing_is_usable():
    """No usable checkpoint must advertise no default, not an unusable one."""
    engine = DepthImageEngine()
    settings = _settings()
    caps = engine.capabilities(settings)
    if not caps.available:
        assert caps.default_model is None
