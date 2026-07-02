"""REST API contract (auth disabled via conftest)."""

import io

from fastapi.testclient import TestClient
from PIL import Image

from app.main import app

client = TestClient(app)


def test_healthz():
    r = client.get("/healthz")
    assert r.status_code == 200 and r.json()["status"] == "ok"


def test_list_engines_includes_preview_and_triposplat():
    r = client.get("/api/v1/engines")
    assert r.status_code == 200
    names = {e["name"] for e in r.json()["engines"]}
    assert {"preview", "triposplat", "sharp", "photogrammetry"} <= names


def test_create_job_requires_input():
    r = client.post("/api/v1/jobs")
    assert r.status_code == 400


def test_create_job_returns_queued_job():
    buf = io.BytesIO()
    Image.new("RGB", (32, 32), (10, 200, 90)).save(buf, format="PNG")
    buf.seek(0)
    r = client.post(
        "/api/v1/jobs",
        files={"files": ("x.png", buf, "image/png")},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] in ("queued", "running", "done")
    assert body["job_id"].startswith("job_")


def test_unknown_job_404():
    assert client.get("/api/v1/jobs/job_deadbeef").status_code == 404
