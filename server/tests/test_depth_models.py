"""The depth model catalog and its three independent gates (deps / licence / weights).

None of this may import torch, so both branches of "are the deps installed" are exercised by
faking the probe rather than by installing a 2 GB wheel in CI.
"""

import importlib.util
import os
from pathlib import Path

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


def test_primary_reason_is_none_when_nothing_is_actually_blocking():
    """A dict of `None`s means every model is fine; the engine must not report a reason."""
    assert catalog.primary_reason({}, "depth-anything-v2-small") is None
    assert catalog.primary_reason({"depth-anything-v2-small": None}, "depth-anything-v2-small") \
        is None


# ── resolution: ids that are not simply right or simply wrong ─────────────────────────────

def test_an_empty_model_id_means_unspecified_not_unknown(deps_installed):
    """An untouched `<select>` posts "", and `engine="depth-image:"` splits to an empty model.

    Treating that as a requested-but-unknown id would fail a job that never named a model, so
    it has to fall through to the configured default exactly as `None` does.
    """
    assert catalog.resolve("", catalog.IMAGE_MODELS, "midas-dpt-hybrid", deps_installed,
                           engine_name="depth-image").id == "midas-dpt-hybrid"


def test_a_checkpoint_from_the_other_engine_is_rejected(deps_installed):
    """The two catalogs overlap but are not equal, and the shorthand makes crossing them easy.

    `engine="depth-image:video-depth-anything-small"` is a plausible thing for a client with
    one dropdown to build. Accepting it would hand the image engine an external-CLI spec whose
    `hf_repo` is empty, and `from_pretrained("")` fails much further downstream.
    """
    with pytest.raises(EngineError, match="Unknown model 'video-depth-anything-small'"):
        catalog.resolve("video-depth-anything-small", catalog.IMAGE_MODELS,
                        "depth-anything-v2-small", deps_installed, engine_name="depth-image")

    # And the other direction: Depth Pro is image-only, not in the video catalog.
    with pytest.raises(EngineError, match="Unknown model 'depth-pro'"):
        catalog.resolve("depth-pro", catalog.VIDEO_MODELS, "depth-anything-v2-small",
                        deps_installed, engine_name="depth-video")


def test_a_model_id_that_still_contains_a_colon_is_rejected_not_re_split(deps_installed):
    """Splitting the shorthand is the router's job and happens exactly once.

    If `resolve` also split on ":" then `model="depth-image:depth-pro"` would quietly work,
    and the licence gate on depth-pro would be reached through a path nobody audited.
    """
    with pytest.raises(EngineError, match="Unknown model"):
        catalog.resolve("depth-image:depth-anything-v2-small", catalog.IMAGE_MODELS,
                        "depth-anything-v2-small", deps_installed, engine_name="depth-image")


def test_the_unknown_model_error_enumerates_only_this_engines_catalog(deps_installed):
    """The message is the only discovery mechanism an agent calling the API has."""
    with pytest.raises(EngineError) as exc:
        catalog.resolve("nope", catalog.VIDEO_MODELS, "depth-anything-v2-small",
                        deps_installed, engine_name="depth-video")
    message = str(exc.value)
    assert "video-depth-anything-small" in message
    assert "depth-pro" not in message, "the video engine cannot run depth-pro"


def test_resolve_skips_an_unusable_default_but_not_an_unusable_request(monkeypatch):
    """The asymmetry that makes the fallback safe: only an *unspecified* model may be swapped.

    Same settings, same catalog, two calls — one names the gated model and fails, one names
    nothing and gets a working substitute.
    """
    monkeypatch.setattr(catalog, "missing_python_deps", lambda: [])
    monkeypatch.setattr(catalog, "downloads_disabled", lambda: False)
    settings = _settings(depth_model="depth-pro")  # non-commercial, gated off

    with pytest.raises(EngineError, match="DEPTH_ALLOW_NONCOMMERCIAL"):
        catalog.resolve("depth-pro", catalog.IMAGE_MODELS, settings.depth_model, settings,
                        engine_name="depth-image")
    assert catalog.resolve(None, catalog.IMAGE_MODELS, settings.depth_model, settings,
                           engine_name="depth-image").commercial is True


# ── gate interactions ─────────────────────────────────────────────────────────────────────

def test_an_external_cli_checkpoint_ignores_the_python_and_weight_gates(monkeypatch):
    """Video Depth Anything is a subprocess, so torch and the HF cache say nothing about it.

    Only the engine that owns the binary can resolve it — it knows the env var. Reporting
    "install torch" for a checkpoint that never touches torch sends the operator to the wrong
    machine entirely.
    """
    monkeypatch.setattr(catalog, "missing_python_deps", lambda: ["torch", "transformers"])
    monkeypatch.setattr(catalog, "downloads_disabled", lambda: True)
    available, reason = catalog.availability(catalog.VIDEO_DEPTH_ANYTHING_SMALL, _settings())
    assert available is True and reason is None


def test_the_licence_gate_is_checked_before_the_dependency_gate(monkeypatch):
    """Order matters because only one message can be shown.

    With no torch AND a non-commercial checkpoint, "install the extra" is the wrong advice:
    installing it changes nothing, the weights are still refused. The policy decision has to
    win over the install hint.
    """
    monkeypatch.setattr(catalog, "missing_python_deps", lambda: ["torch"])
    _available, reason = catalog.availability(catalog.DEPTH_PRO, _settings())
    assert "DEPTH_ALLOW_NONCOMMERCIAL" in reason
    assert "pip install" not in reason


def test_weights_cached_is_false_for_a_checkpoint_with_no_hub_repo():
    """CLI checkpoints have no HF snapshot to find, so the probe must not guess at a folder."""
    assert catalog.weights_cached(catalog.VIDEO_DEPTH_ANYTHING_SMALL, _settings()) is False


@pytest.mark.skipif(hasattr(os, "geteuid") and os.geteuid() == 0,
                    reason="root can read a 0o000 directory, so the OSError never happens")
def test_an_unreadable_cache_root_is_skipped_rather_than_crashing_the_engine_list(
    monkeypatch, tmp_path
):
    """`GET /engines` walks every cache root on every request.

    A bind-mounted, root-owned weights directory is a completely ordinary deployment, and an
    unhandled PermissionError there would take out the whole endpoint — not just the one model
    it could not inspect. The later roots must still be consulted.
    """
    spec = catalog.DEPTH_ANYTHING_V2_SMALL
    folder = "models--" + spec.hf_repo.replace("/", "--")

    locked = tmp_path / "locked"
    (locked / folder / "snapshots").mkdir(parents=True)
    readable = tmp_path / "readable"
    snapshot = readable / folder / "snapshots" / "abc123"
    snapshot.mkdir(parents=True)
    (snapshot / "model.safetensors").write_bytes(b"\x00")

    monkeypatch.setenv("HF_HUB_CACHE", str(readable))
    (locked / folder / "snapshots").chmod(0o000)
    try:
        assert catalog.weights_cached(spec, _settings(model_weights_dir=locked)) is True
    finally:
        (locked / folder / "snapshots").chmod(0o755)  # or tmp_path teardown fails


def test_cache_roots_are_ordered_most_specific_first(monkeypatch, tmp_path):
    """A read-only weights mount must win over whatever the ambient HF cache happens to hold.

    Otherwise a stale copy in the developer's `~/.cache` shadows the pinned revision the
    deployment deliberately bind-mounted.
    """
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path / "env-cache"))
    monkeypatch.setenv("HF_HOME", str(tmp_path / "home"))
    roots = catalog.cache_roots(_settings(model_weights_dir=tmp_path / "mount"))
    assert roots == [tmp_path / "mount", tmp_path / "env-cache", tmp_path / "home" / "hub"]


def test_the_legacy_transformers_cache_variable_is_still_honoured(monkeypatch, tmp_path):
    monkeypatch.delenv("HF_HUB_CACHE", raising=False)
    monkeypatch.setenv("TRANSFORMERS_CACHE", str(tmp_path / "legacy"))
    assert tmp_path / "legacy" in catalog.cache_roots(_settings())


def test_the_ambient_home_cache_is_the_last_resort(monkeypatch):
    """With nothing configured, the list still ends somewhere real — this is the root the
    autouse fixture above exists to neutralise."""
    monkeypatch.delenv("HF_HUB_CACHE", raising=False)
    monkeypatch.delenv("TRANSFORMERS_CACHE", raising=False)
    monkeypatch.delenv("HF_HOME", raising=False)
    assert catalog.cache_roots(_settings())[-1] == Path.home() / ".cache" / "huggingface" / "hub"


@pytest.mark.parametrize("value", ["1", "true", "TRUE", "yes", "On", " 1 "])
def test_offline_mode_accepts_the_spellings_people_actually_write(monkeypatch, value):
    monkeypatch.setenv("HF_HUB_OFFLINE", value)
    assert catalog.downloads_disabled() is True


@pytest.mark.parametrize("value", ["0", "false", "no", "off", "", "  "])
def test_offline_mode_is_not_triggered_by_a_falsy_value(monkeypatch, value):
    """`HF_HUB_OFFLINE=0` is how a user turns it *off*; reading it as set would strand them."""
    for var in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "PTM_NO_DOWNLOAD"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("HF_HUB_OFFLINE", value)
    assert catalog.downloads_disabled() is False


def test_a_half_uninstalled_distribution_counts_as_missing(monkeypatch):
    """`find_spec` raises ValueError when a module is present but its __spec__ is None.

    That happens after a failed or interrupted uninstall, and it is exactly the machine where
    someone is debugging depth. An exception here escapes through `GET /api/v1/engines`.
    """
    def raise_it(name):
        raise ValueError(f"{name}.__spec__ is None")

    monkeypatch.setattr(importlib.util, "find_spec", raise_it)
    assert catalog.missing_python_deps() == ["torch", "torchvision", "transformers"]


def test_a_missing_parent_package_counts_as_missing(monkeypatch):
    def raise_it(name):
        raise ModuleNotFoundError(f"No module named {name!r}")

    monkeypatch.setattr(importlib.util, "find_spec", raise_it)
    assert catalog.missing_python_deps() == ["torch", "torchvision", "transformers"]


# ── the API payload ───────────────────────────────────────────────────────────────────────

def test_describe_reports_the_gate_result_alongside_the_catalog_entry(deps_installed):
    """`models[]` is what the client's picker renders; a blocked entry must say why, in place.

    A single engine-level boolean cannot express "small works, large needs 1.3 GB you have not
    downloaded" — which is the whole reason this list exists.
    """
    ok = catalog.describe(catalog.DEPTH_ANYTHING_V2_SMALL, deps_installed)
    assert ok.available is True and ok.unavailable_reason is None
    assert ok.id == "depth-anything-v2-small"
    assert ok.license == "Apache-2.0" and ok.commercial is True

    gated = catalog.describe(catalog.DEPTH_PRO, deps_installed)
    assert gated.available is False
    assert "DEPTH_ALLOW_NONCOMMERCIAL" in gated.unavailable_reason
    assert gated.weights_cached is False
    assert gated.approx_download_mb == 1900
    assert gated.requires_gpu is catalog.DEPTH_PRO.prefers_gpu
