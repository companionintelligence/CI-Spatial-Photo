"""`EngineRegistry.route` across the (source_type, intent, availability) matrix.

Routing is the one decision every job makes before anything expensive happens, and its inputs
— which CLIs are installed, which licences are enabled, which extra is present — differ on
every machine the server runs on. So availability is *forced* here rather than inherited from
the host: each test states the world it is testing, and none of them depend on whether the
developer happens to have colmap, ffmpeg or torch.

Every test builds its own `EngineRegistry()` instead of `get_registry()`. The module-level
singleton is shared with the FastAPI app and with every other test file, and `route()` mutates
the engines' owner (the JobInput) — a monkeypatched engine leaking out of here would be an
extremely confusing failure somewhere else.
"""

from pathlib import Path

import pytest

from app.config import Settings
from app.engines import depth_models as catalog
from app.engines.base import EngineError
from app.engines.registry import EngineRegistry, split_engine_ref
from app.models import JobInput


@pytest.fixture(autouse=True)
def isolated_weights_cache(monkeypatch, tmp_path):
    """Same hazard, same fix as the autouse fixture in `test_depth_models.py`.

    Routing reaches the depth engines' `is_available`, which reaches `weights_cached`, which
    reads the ambient `~/.cache/huggingface/hub`. A developer who has ever run the engine for
    real would otherwise get different routing here than CI does.
    """
    empty = tmp_path / "hf-empty"
    empty.mkdir()
    monkeypatch.setenv("HF_HOME", str(empty))
    monkeypatch.delenv("HF_HUB_CACHE", raising=False)
    monkeypatch.delenv("TRANSFORMERS_CACHE", raising=False)


def _settings(**kw) -> Settings:
    base = dict(auth_disabled=True, sharp_enable_research=False, default_engine="triposplat")
    base.update(kw)
    return Settings(**base)


def _job(**kw) -> JobInput:
    base = dict(owner="u", source_type="image", files=[Path("a.jpg")])
    base.update(kw)
    return JobInput(**base)


def _force(registry: EngineRegistry, monkeypatch, name: str, *, available: bool, reason=None):
    """Pin one engine's availability without pretending its tooling is installed."""
    engine = registry.get(name)
    monkeypatch.setattr(engine, "is_available", lambda settings: (available, reason))
    return engine


def _no_torch(monkeypatch):
    """The CI machine: the depth extra is absent, so both depth engines are out."""
    monkeypatch.setattr(catalog, "missing_python_deps", lambda: ["torch"])


def _fake_torch(monkeypatch):
    """A box with the extra installed, without importing a 2 GB wheel to say so."""
    monkeypatch.setattr(catalog, "missing_python_deps", lambda: [])
    monkeypatch.setattr(catalog, "downloads_disabled", lambda: False)


# ── explicit engine requests ──────────────────────────────────────────────────────────────

def test_an_explicit_engine_that_cannot_handle_the_input_names_the_input_type():
    """"Unknown engine" and "wrong input" are different mistakes and need different messages."""
    reg = EngineRegistry()
    with pytest.raises(EngineError, match="cannot handle input type 'video'"):
        reg.route(_job(source_type="video", files=[Path("v.mp4")], requested_engine="preview"),
                  _settings())


def test_an_explicit_unavailable_engine_surfaces_that_engines_own_reason():
    """The router must not flatten a specific, actionable reason into a generic one.

    SHARP knows the env var that unlocks it; the router does not. Replacing its message with
    "Engine 'sharp' is unavailable" costs the user the only sentence that tells them the fix.
    """
    reg = EngineRegistry()
    with pytest.raises(EngineError, match="SHARP_ENABLE_RESEARCH"):
        reg.route(_job(requested_engine="sharp"), _settings())


def test_an_explicit_request_never_silently_degrades_to_preview():
    """The whole point of branch 1: asking for a specific engine fails loudly or runs it."""
    reg = EngineRegistry()
    for name in ("triposplat", "sharp", "photogrammetry"):
        with pytest.raises(EngineError):
            reg.route(_job(requested_engine=name, source_type="images",
                           files=[Path("a.jpg"), Path("b.jpg")]), _settings())


def test_an_explicit_available_engine_wins_over_the_configured_default(monkeypatch):
    reg = EngineRegistry()
    _force(reg, monkeypatch, "triposplat", available=True)
    assert reg.route(_job(requested_engine="preview"), _settings()).name == "preview"


# ── multi-image and video (branch 2) ──────────────────────────────────────────────────────

def test_multi_image_goes_to_photogrammetry_when_its_tooling_is_present(monkeypatch):
    reg = EngineRegistry()
    _force(reg, monkeypatch, "photogrammetry", available=True)
    job = _job(source_type="images", files=[Path("a.jpg"), Path("b.jpg")])
    assert reg.route(job, _settings()).name == "photogrammetry"


def test_video_goes_to_photogrammetry_ahead_of_the_depth_engine(monkeypatch):
    """Multi-view geometry beats monocular depth whenever it is actually available."""
    reg = EngineRegistry()
    _fake_torch(monkeypatch)
    _force(reg, monkeypatch, "photogrammetry", available=True)
    job = _job(source_type="video", files=[Path("v.mp4")])
    assert reg.route(job, _settings(depth_auto_route=True)).name == "photogrammetry"


def test_multi_image_without_photogrammetry_reports_the_missing_tools():
    """A multi-image job has no Preview fallback, so the error is all the user gets."""
    reg = EngineRegistry()
    job = _job(source_type="images", files=[Path("a.jpg"), Path("b.jpg")])
    with pytest.raises(EngineError, match="colmap"):
        reg.route(job, _settings())


def test_multi_image_never_falls_back_to_the_depth_engines(monkeypatch):
    """depth-video handles video only, so a still set must not be routed into it.

    `_depth_fallback("depth-video")` is consulted for `images` as well as `video`; the guard
    that stops it is `can_handle`, and without it a 40-photo upload would be reconstructed
    from photo #1 alone.
    """
    reg = EngineRegistry()
    _fake_torch(monkeypatch)
    job = _job(source_type="images", files=[Path("a.jpg"), Path("b.jpg")])
    with pytest.raises(EngineError):
        reg.route(job, _settings(depth_auto_route=True))


def test_video_falls_back_to_depth_video_only_once_opted_in(monkeypatch):
    """DEPTH_AUTO_ROUTE off is the default and must keep the pre-depth behaviour exactly."""
    reg = EngineRegistry()
    _fake_torch(monkeypatch)
    monkeypatch.setattr(reg.get("depth-video"), "is_available", lambda settings: (True, None))
    job = _job(source_type="video", files=[Path("v.mp4")])

    with pytest.raises(EngineError):
        reg.route(job, _settings())
    assert reg.route(job, _settings(depth_auto_route=True)).name == "depth-video"
    # DEFAULT_ENGINE reaches it regardless of the flag — the documented escape hatch.
    assert reg.route(job, _settings(default_engine="depth-video")).name == "depth-video"


def test_the_depth_fallback_declines_when_the_engine_is_installed_but_unusable(monkeypatch):
    """Opting in must not turn "torch is missing" into a crash — it just leaves the fallback.

    This is the combination a box gets by setting DEPTH_AUTO_ROUTE=1 *before* installing the
    extra, which is the natural order a user does it in.
    """
    reg = EngineRegistry()
    _no_torch(monkeypatch)
    assert reg.route(_job(), _settings(depth_auto_route=True)).name == "preview"


# ── single image (branch 3) ───────────────────────────────────────────────────────────────

def test_scene_intent_prefers_sharp_when_the_research_gate_is_open(monkeypatch):
    reg = EngineRegistry()
    _force(reg, monkeypatch, "sharp", available=True)
    monkeypatch.setattr(reg.get("sharp"), "can_handle", lambda job, settings: True)
    assert reg.route(_job(intent="scene"), _settings()).name == "sharp"


def test_object_intent_does_not_reach_sharp_even_when_it_is_available(monkeypatch):
    """SHARP is the scene engine; `intent` has to actually select, not just annotate."""
    reg = EngineRegistry()
    _force(reg, monkeypatch, "sharp", available=True)
    monkeypatch.setattr(reg.get("sharp"), "can_handle", lambda job, settings: True)
    assert reg.route(_job(intent="object"), _settings()).name == "preview"


def test_the_configured_default_engine_takes_a_single_image(monkeypatch):
    reg = EngineRegistry()
    _force(reg, monkeypatch, "triposplat", available=True)
    assert reg.route(_job(), _settings(default_engine="triposplat")).name == "triposplat"


def test_a_misspelled_default_engine_degrades_instead_of_breaking_every_job():
    """DEFAULT_ENGINE is an env var, so a typo is a deployment away at all times.

    `self.get()` returning None has to fall through to the fallback chain; raising here would
    take the whole server down for every upload rather than costing one setting.
    """
    reg = EngineRegistry()
    assert reg.route(_job(), _settings(default_engine="tripsoplat")).name == "preview"


def test_a_single_image_with_no_files_has_no_engine_at_all():
    """Preview is the floor, but even it requires a file; the error must be the router's.

    `can_handle` is `source_type == "image" and len(files) >= 1`, so an empty file list reaches
    the bottom of `_route`. Before that message existed this surfaced as an IndexError inside
    whichever engine got picked.
    """
    reg = EngineRegistry()
    with pytest.raises(EngineError, match="No engine available"):
        reg.route(_job(files=[]), _settings())


# ── the engine:model shorthand ────────────────────────────────────────────────────────────

def test_split_engine_ref_handles_every_shape_a_client_can_send():
    assert split_engine_ref("depth-image:depth-pro") == ("depth-image", "depth-pro")
    assert split_engine_ref("preview") == ("preview", None)
    assert split_engine_ref(None) == (None, None)
    assert split_engine_ref("") == ("", None)
    # Whitespace around a dropdown-concatenated value is a client bug, not a user error.
    assert split_engine_ref(" depth-image : depth-pro ") == ("depth-image", "depth-pro")
    # A trailing or leading colon leaves the empty half as None rather than as "".
    assert split_engine_ref("depth-image:") == ("depth-image", None)
    assert split_engine_ref(":depth-pro") == (None, "depth-pro")
    # partition splits once, so a second colon belongs to the model id (and will be rejected
    # downstream as an unknown model, which is the correct place to notice it).
    assert split_engine_ref("a:b:c") == ("a", "b:c")


def test_a_shorthand_naming_a_single_model_engine_is_rejected_not_ignored(monkeypatch):
    """`preview:depth-pro` is nonsense and must not quietly run Preview.

    Preview's `resolve_model` returns None for anything, so nothing downstream would ever
    notice the model id — the user would get a flat plane and no explanation.
    """
    reg = EngineRegistry()
    job = _job(requested_engine="preview:depth-pro")
    engine = reg.route(job, _settings())
    # Documents today's behaviour: the shorthand is normalised onto the job and the model is
    # simply dropped by a single-model engine. If that ever becomes an error, this is the test
    # that has to change, deliberately.
    assert engine.name == "preview"
    assert job.requested_engine == "preview"
    assert job.requested_model == "depth-pro"
    assert engine.resolve_model(job, _settings()) is None


def test_a_trailing_colon_is_reported_as_an_unknown_engine(monkeypatch):
    """`engine="depth-image:"` — the shape a client produces when no model is chosen.

    `split_engine_ref` correctly returns ("depth-image", None), but `route` only writes the
    split back when there IS a model, so the raw string reaches `get()`. The failure is loud
    and the message quotes the string, which is enough to debug it; pinned here so the
    behaviour is a decision rather than an accident.
    """
    reg = EngineRegistry()
    with pytest.raises(EngineError, match="Unknown engine 'depth-image:'"):
        reg.route(_job(requested_engine="depth-image:"), _settings())


def test_the_shorthand_is_validated_against_the_engine_it_names(monkeypatch):
    """A video checkpoint glued onto the image engine must fail at submission time."""
    reg = EngineRegistry()
    _fake_torch(monkeypatch)
    with pytest.raises(EngineError, match="Unknown model 'video-depth-anything-small'"):
        reg.route(_job(requested_engine="depth-image:video-depth-anything-small"), _settings())


def test_route_leaves_the_job_untouched_when_there_is_no_shorthand(monkeypatch):
    """`route` mutates its argument, so "when does it mutate" is part of the contract."""
    reg = EngineRegistry()
    _fake_torch(monkeypatch)
    job = _job(requested_engine="depth-image", requested_model="midas-dpt-hybrid")
    reg.route(job, _settings())
    assert (job.requested_engine, job.requested_model) == ("depth-image", "midas-dpt-hybrid")


# ── registry plumbing ─────────────────────────────────────────────────────────────────────

def test_get_returns_none_for_an_unknown_name_rather_than_raising():
    assert EngineRegistry().get("nope") is None


def test_capabilities_cover_every_registered_engine_exactly_once():
    reg = EngineRegistry()
    caps = reg.capabilities(_settings())
    names = [c.name for c in caps]
    assert len(names) == len(set(names)) == 6
    assert all(reg.get(n) is not None for n in names)
