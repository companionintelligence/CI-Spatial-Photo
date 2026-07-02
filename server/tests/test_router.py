"""Input-router decisions (deterministic, no engine execution)."""

from pathlib import Path

import pytest

from app.config import Settings
from app.engines import EngineError, get_registry
from app.models import JobInput


def _settings(**kw) -> Settings:
    base = dict(auth_disabled=True, sharp_enable_research=False, default_engine="triposplat")
    base.update(kw)
    return Settings(**base)


def test_single_image_falls_back_to_preview_when_triposplat_absent():
    reg = get_registry()
    ji = JobInput(owner="u", source_type="image", files=[Path("a.jpg")])
    engine = reg.route(ji, _settings())
    # TripoSplat CLI is not installed in CI, so the router must degrade to the CPU preview.
    assert engine.name == "preview"


def test_explicit_unknown_engine_raises():
    reg = get_registry()
    ji = JobInput(owner="u", source_type="image", files=[Path("a.jpg")], requested_engine="nope")
    with pytest.raises(EngineError):
        reg.route(ji, _settings())


def test_video_without_photogrammetry_tooling_raises():
    reg = get_registry()
    ji = JobInput(owner="u", source_type="video", files=[Path("v.mp4")])
    with pytest.raises(EngineError):
        reg.route(ji, _settings())


def test_sharp_gated_off_by_default():
    reg = get_registry()
    caps = {c.name: c for c in reg.capabilities(_settings())}
    assert caps["sharp"].available is False
    assert caps["preview"].available is True
    assert caps["sharp"].commercial is False


def test_sharp_scene_intent_still_falls_back_when_disabled():
    reg = get_registry()
    ji = JobInput(owner="u", source_type="image", files=[Path("a.jpg")], intent="scene")
    engine = reg.route(ji, _settings())
    assert engine.name == "preview"  # sharp disabled -> preview
