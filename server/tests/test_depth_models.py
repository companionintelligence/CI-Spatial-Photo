"""The depth model catalog and its three independent gates (deps / licence / weights).

None of this may import torch, so both branches of "are the deps installed" are exercised by
faking the probe rather than by installing a 2 GB wheel in CI.
"""

import pytest

from app.config import Settings
from app.engines import depth_models as catalog
from app.engines.base import EngineError


def _settings(**kw) -> Settings:
    base = dict(auth_disabled=True, depth_allow_noncommercial=False)
    base.update(kw)
    return Settings(**base)


@pytest.fixture(autouse=True)
def isolated_weights_cache(monkeypatch, tmp_path):
    """Point every cache root at an empty directory, for EVERY test in this module.

    `cache_roots` always ends with the ambient `~/.cache/huggingface/hub` (or
    `$HF_HOME/hub`), so a test that only overrides `model_weights_dir` still
    sees whatever the developer has downloaded. That made the weights gate pass
    on a clean machine and fail on any box that had run the engine once —
    caught exactly that way: these tests were green until a real end-to-end run
    pulled Depth Anything V2 Small into the user's cache, and then
    `test_uncached_weights_block_only_when_downloads_are_disabled` failed
    because the weights it calls "uncached" were now on disk.

    Autouse rather than opt-in: the dependency is invisible at the call site,
    so any future test that touches `availability` or `weights_cached` would
    inherit the same flake without anyone noticing.
    """
    empty = tmp_path / "hf-empty"
    empty.mkdir()
    monkeypatch.setenv("HF_HOME", str(empty))
    monkeypatch.delenv("HF_HUB_CACHE", raising=False)
    monkeypatch.delenv("TRANSFORMERS_CACHE", raising=False)
    return empty


@pytest.fixture()
def deps_installed(monkeypatch):
    """Pretend torch + transformers are importable without importing them."""
    monkeypatch.setattr(catalog, "missing_python_deps", lambda: [])
    monkeypatch.setattr(catalog, "downloads_disabled", lambda: False)
    return _settings()


# ── catalog shape ─────────────────────────────────────────────────────────────────────────

def test_model_ids_are_unique_and_stable():
    ids = [m.id for m in (*catalog.IMAGE_MODELS, *catalog.VIDEO_MODELS)]
    assert len(set(ids)) == len(catalog.BY_ID)
    # These strings are the public API of the `model` job field; renaming one breaks callers.
    assert {"depth-anything-v2-small", "depth-anything-v2-base", "depth-anything-v2-large",
            "midas-dpt-hybrid", "midas-dpt-large", "depth-pro"} == {m.id for m in catalog.IMAGE_MODELS}
    assert {"video-depth-anything-small", "video-depth-anything-large"} <= {
        m.id for m in catalog.VIDEO_MODELS
    }


def test_video_catalog_reuses_the_per_frame_image_checkpoints():
    """The fallback path is what makes depth-video usable without the VDA binary."""
    per_frame = [m for m in catalog.VIDEO_MODELS if m.loader == "transformers"]
    assert per_frame, "video must offer an in-process option"
    assert all(m in catalog.IMAGE_MODELS for m in per_frame)


def test_every_transformers_model_declares_a_repo_and_every_cli_model_an_encoder():
    for spec in catalog.BY_ID.values():
        if spec.loader == "transformers":
            assert spec.hf_repo and "/" in spec.hf_repo
        else:
            assert spec.cli_encoder


def test_relative_and_metric_kinds_are_labelled_correctly():
    """`kind` drives the inversion in plywriter; getting it wrong turns a scene inside out."""
    assert catalog.DEPTH_PRO.kind == "metric"
    assert catalog.DEPTH_ANYTHING_V2_SMALL.kind == "relative"
    assert catalog.MIDAS_DPT_LARGE.kind == "relative"


# ── gate 1: python deps ───────────────────────────────────────────────────────────────────

def test_missing_deps_reported_without_importing_torch(monkeypatch):
    monkeypatch.setattr(catalog, "missing_python_deps", lambda: ["torch", "transformers"])
    available, reason = catalog.availability(catalog.DEPTH_ANYTHING_V2_SMALL, _settings())
    assert available is False
    assert "torch" in reason and "[depth]" in reason


def test_real_dep_probe_does_not_raise_and_returns_pip_names():
    """The probe itself must be safe to call on any machine — it runs on every /engines hit."""
    missing = catalog.missing_python_deps()
    assert set(missing) <= {"torch", "torchvision", "transformers"}


def test_torchvision_is_probed_even_though_this_project_never_imports_it():
    """Regression: transformers 5's AutoImageProcessor hard-requires torchvision.

    Without it in the probe the engine reports itself available, accepts a job, and then dies
    inside `from_pretrained` with "requires the Torchvision library" — a failure that reads like
    a broken model rather than a missing install. Found by actually running the engine.
    """
    probed = {pip_name for _, pip_name in catalog._TRANSFORMERS_DEPS}
    assert probed == {"torch", "torchvision", "transformers"}


# ── gate 2: licence ───────────────────────────────────────────────────────────────────────

def test_noncommercial_weights_are_gated_off_by_default(deps_installed):
    for spec in (catalog.DEPTH_ANYTHING_V2_LARGE, catalog.DEPTH_PRO,
                 catalog.VIDEO_DEPTH_ANYTHING_LARGE):
        available, reason = catalog.availability(spec, deps_installed)
        assert available is False
        assert "DEPTH_ALLOW_NONCOMMERCIAL" in reason


def test_licence_gate_does_not_touch_permissive_weights(deps_installed):
    for spec in (catalog.DEPTH_ANYTHING_V2_SMALL, catalog.MIDAS_DPT_HYBRID,
                 catalog.MIDAS_DPT_LARGE):
        assert catalog.availability(spec, deps_installed)[0] is True


def test_opting_in_unlocks_the_research_weights(monkeypatch):
    monkeypatch.setattr(catalog, "missing_python_deps", lambda: [])
    monkeypatch.setattr(catalog, "downloads_disabled", lambda: False)
    settings = _settings(depth_allow_noncommercial=True)
    assert catalog.availability(catalog.DEPTH_PRO, settings)[0] is True


# ── gate 3: weights on disk ───────────────────────────────────────────────────────────────

def test_uncached_weights_block_only_when_downloads_are_disabled(monkeypatch, tmp_path):
    monkeypatch.setattr(catalog, "missing_python_deps", lambda: [])
    settings = _settings(model_weights_dir=tmp_path)

    monkeypatch.setattr(catalog, "downloads_disabled", lambda: False)
    assert catalog.availability(catalog.DEPTH_ANYTHING_V2_SMALL, settings)[0] is True

    monkeypatch.setattr(catalog, "downloads_disabled", lambda: True)
    available, reason = catalog.availability(catalog.DEPTH_ANYTHING_V2_SMALL, settings)
    assert available is False
    assert "not in the local cache" in reason
    assert str(tmp_path) in reason  # tells the operator exactly where to put them


def test_weights_cached_reads_the_huggingface_cache_layout(monkeypatch, tmp_path):
    spec = catalog.DEPTH_ANYTHING_V2_SMALL
    settings = _settings(model_weights_dir=tmp_path)
    monkeypatch.delenv("HF_HUB_CACHE", raising=False)
    monkeypatch.delenv("TRANSFORMERS_CACHE", raising=False)
    monkeypatch.setenv("HF_HOME", str(tmp_path / "nowhere"))
    assert catalog.weights_cached(spec, settings) is False

    snapshot = tmp_path / f"models--{spec.hf_repo.replace('/', '--')}" / "snapshots" / "abc123"
    snapshot.mkdir(parents=True)
    assert catalog.weights_cached(spec, settings) is False, "an empty snapshot dir is not weights"
    (snapshot / "model.safetensors").write_bytes(b"\x00")
    assert catalog.weights_cached(spec, settings) is True


def test_downloads_disabled_honours_each_offline_switch(monkeypatch):
    for var in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "PTM_NO_DOWNLOAD"):
        monkeypatch.delenv("HF_HUB_OFFLINE", raising=False)
        monkeypatch.delenv("TRANSFORMERS_OFFLINE", raising=False)
        monkeypatch.delenv("PTM_NO_DOWNLOAD", raising=False)
        assert catalog.downloads_disabled() is False
        monkeypatch.setenv(var, "1")
        assert catalog.downloads_disabled() is True, var


# ── resolution ────────────────────────────────────────────────────────────────────────────

def test_resolve_honours_an_explicit_request(deps_installed):
    spec = catalog.resolve(
        "midas-dpt-hybrid", catalog.IMAGE_MODELS, "depth-anything-v2-small", deps_installed,
        engine_name="depth-image",
    )
    assert spec.id == "midas-dpt-hybrid"


def test_resolve_rejects_an_unknown_id_and_lists_the_real_ones(deps_installed):
    with pytest.raises(EngineError) as exc:
        catalog.resolve(
            "depth-anything-v3", catalog.IMAGE_MODELS, "depth-anything-v2-small", deps_installed,
            engine_name="depth-image",
        )
    assert "depth-anything-v3" in str(exc.value)
    assert "midas-dpt-hybrid" in str(exc.value), "the error should enumerate the valid choices"


def test_resolve_refuses_to_silently_substitute_a_gated_model(deps_installed):
    """Asking for Large and quietly getting Small is the bug report nobody can diagnose."""
    with pytest.raises(EngineError) as exc:
        catalog.resolve(
            "depth-anything-v2-large", catalog.IMAGE_MODELS, "depth-anything-v2-small",
            deps_installed, engine_name="depth-image",
        )
    assert "DEPTH_ALLOW_NONCOMMERCIAL" in str(exc.value)


def test_resolve_falls_back_when_nothing_was_requested(monkeypatch, deps_installed):
    """No explicit choice + an unusable default = use something that works, not an error."""
    settings = _settings(depth_model="depth-pro")  # non-commercial, gated off
    monkeypatch.setattr(catalog, "missing_python_deps", lambda: [])
    monkeypatch.setattr(catalog, "downloads_disabled", lambda: False)
    spec = catalog.resolve(None, catalog.IMAGE_MODELS, settings.depth_model, settings,
                           engine_name="depth-image")
    assert spec.commercial is True


def test_resolve_prefers_the_configured_default(deps_installed):
    spec = catalog.resolve(None, catalog.IMAGE_MODELS, "midas-dpt-large", deps_installed,
                           engine_name="depth-image")
    assert spec.id == "midas-dpt-large"


def test_resolve_raises_when_every_model_is_gated(monkeypatch):
    monkeypatch.setattr(catalog, "missing_python_deps", lambda: ["torch"])
    with pytest.raises(EngineError):
        catalog.resolve(None, catalog.IMAGE_MODELS, "depth-anything-v2-small", _settings(),
                        engine_name="depth-image")


def test_primary_reason_prefers_the_configured_default():
    """Whichever model is first in the catalog must not hijack the engine-level message."""
    reasons = {"video-depth-anything-small": "install the CLI",
               "depth-anything-v2-small": "install torch"}
    assert catalog.primary_reason(reasons, "depth-anything-v2-small") == "install torch"
    assert catalog.primary_reason(reasons, "not-a-model") == "install the CLI"
