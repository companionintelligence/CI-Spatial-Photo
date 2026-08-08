"""REST surface for the depth engines, and the backward compatibility of the additions.

`GET /api/v1/engines` and `POST /api/v1/jobs` are consumed by a React client this change does
not ship with, so the payload shape is a contract with code that will not be recompiled
alongside it. These tests pin the old fields as much as the new ones.
"""

import io

from fastapi.testclient import TestClient
from PIL import Image

from app.main import app

client = TestClient(app)

# The exact keys the pre-existing client's EngineCapabilities interface reads.
LEGACY_ENGINE_FIELDS = {
    "name", "description", "inputs", "intents", "output_kind", "output_formats",
    "commercial", "requires_gpu", "license", "available", "unavailable_reason",
}


def _engines() -> dict[str, dict]:
    r = client.get("/api/v1/engines")
    assert r.status_code == 200, r.text
    return {e["name"]: e for e in r.json()["engines"]}


def test_depth_engines_are_listed_alongside_the_originals():
    names = set(_engines())
    assert {"preview", "triposplat", "sharp", "photogrammetry"} <= names
    assert {"depth-image", "depth-video"} <= names


def test_every_engine_still_carries_every_legacy_field():
    for name, entry in _engines().items():
        assert LEGACY_ENGINE_FIELDS <= set(entry), f"{name} lost a field the client reads"


def test_new_fields_are_additive_and_default_empty_for_old_engines():
    engines = _engines()
    assert engines["preview"]["models"] == []
    assert engines["preview"]["default_model"] is None
    assert len(engines["depth-image"]["models"]) == 6
    assert len(engines["depth-video"]["models"]) == 7


def test_model_entries_carry_what_a_picker_needs():
    entry = _engines()["depth-image"]["models"][0]
    assert entry["id"] == "depth-anything-v2-small"
    for key in ("label", "description", "license", "commercial", "available",
                "approx_download_mb", "weights_cached"):
        assert key in entry


def test_depth_engine_reports_an_actionable_reason_when_unusable():
    entry = _engines()["depth-image"]
    if entry["available"]:
        return  # a box with the [depth] extra installed; nothing to assert here
    assert entry["unavailable_reason"]
    assert "pip install" in entry["unavailable_reason"]


def _png() -> io.BytesIO:
    buf = io.BytesIO()
    Image.new("RGB", (32, 32), (10, 200, 90)).save(buf, format="PNG")
    buf.seek(0)
    return buf


def test_create_job_still_works_without_the_model_field():
    r = client.post("/api/v1/jobs", files={"files": ("x.png", _png(), "image/png")})
    assert r.status_code == 200, r.text
    assert r.json()["job_id"].startswith("job_")


def test_create_job_accepts_the_model_field():
    r = client.post(
        "/api/v1/jobs",
        files={"files": ("x.png", _png(), "image/png")},
        data={"engine": "depth-image", "model": "depth-anything-v2-large"},
    )
    # The job is accepted; whether the engine can honour it is reported through the job record,
    # which is the same contract an unavailable TripoSplat has had since 2.0.0.
    assert r.status_code == 200, r.text
    assert r.json()["status"] in ("queued", "running", "done", "error")


def test_openapi_documents_the_model_form_field():
    """The field has to be discoverable — /docs is how agents and integrators find it."""
    schema = client.get("/openapi.json").json()
    body = schema["paths"]["/api/v1/jobs"]["post"]["requestBody"]
    props = next(iter(body["content"].values()))["schema"]
    ref = props.get("$ref", "")
    if ref:
        props = schema["components"]["schemas"][ref.rsplit("/", 1)[-1]]
    assert "model" in props["properties"]
    assert "engine" in props["properties"]
