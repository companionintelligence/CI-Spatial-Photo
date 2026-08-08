"""The REST surface's input parsing, error codes, and asset delivery.

Two halves, deliberately separated:

* **Submission** — `POST /jobs` is the only endpoint that parses untrusted multipart data.
  Those tests intercept `create_job` and assert on the `JobInput` that was built, so they
  measure the parsing and nothing else: no engine runs, no background task, no timing.
* **Delivery** — the asset endpoints are driven against assets written straight into the
  store, for the same reason. Waiting on a real job to produce an asset would make every
  assertion about a 404 depend on the preview engine's runtime.

The client this serves is a separate React build that is not recompiled alongside the server,
so a status code changing from 404 to 500 is a breaking change even when the body is similar.
"""

import io
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.main import app
from app.models import Asset, EngineResult, Job, JobInput
from app.routes import _classify

client = TestClient(app)

OWNER = "dev@local"  # what require_principal returns with AUTH_DISABLED=1


def _png(color=(10, 200, 90)) -> io.BytesIO:
    buf = io.BytesIO()
    Image.new("RGB", (16, 16), color).save(buf, format="PNG")
    buf.seek(0)
    return buf


@pytest.fixture()
def captured(monkeypatch) -> list[JobInput]:
    """Intercept job submission and hand back the parsed JobInput instead of running it."""
    seen: list[JobInput] = []

    def capture(job_input: JobInput) -> Job:
        seen.append(job_input)
        return Job(job_id="job_captured", owner=job_input.owner, status="queued")

    monkeypatch.setattr(app.state.jobs, "create_job", capture)
    return seen


# ── source classification ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "names, expected",
    [
        (["a.jpg"], "image"),
        (["a.HEIC"], "image"),
        (["a.jpg", "b.png"], "images"),
        (["clip.mp4"], "video"),
        (["a.jpg", "b.jpg", "clip.MOV"], "video"),   # one clip in a set is still a video job
        (["a.jpg", "notes.txt"], "images"),          # unknown extensions are not videos
        (["no-extension"], "image"),
        ([], "image"),
    ],
)
def test_filenames_classify_to_the_right_source_type(names, expected):
    """Classification decides which engines are even eligible, from the filename alone —
    the upload has not been opened at this point, so the extension is all there is."""
    assert _classify(names) == expected


def test_an_explicit_source_type_overrides_the_filename(captured):
    """A memory-sourced clip can arrive with no useful name; the client can say what it is."""
    client.post(
        "/api/v1/jobs",
        files={"files": ("frame.png", _png(), "image/png")},
        data={"source_type": "video"},
    )
    assert captured[0].source_type == "video"


def test_a_nonsense_source_type_falls_back_to_the_filename_instead_of_erroring(captured):
    """`source_type` is a free-text form field; an unrecognised value must not 500 or
    propagate into the router as an unmatched literal."""
    client.post(
        "/api/v1/jobs",
        files={"files": ("frame.png", _png(), "image/png")},
        data={"source_type": "hologram"},
    )
    assert captured[0].source_type == "image"


def test_an_unrecognised_intent_falls_back_to_auto(captured):
    client.post(
        "/api/v1/jobs",
        files={"files": ("a.png", _png(), "image/png")},
        data={"intent": "telepathy"},
    )
    assert captured[0].intent == "auto"


@pytest.mark.parametrize("intent", ["auto", "object", "scene"])
def test_the_documented_intents_pass_through(captured, intent):
    client.post(
        "/api/v1/jobs", files={"files": ("a.png", _png(), "image/png")}, data={"intent": intent}
    )
    assert captured[0].intent == intent


# ── upload filename handling ──────────────────────────────────────────────────────────────

def test_a_traversal_filename_is_reduced_to_its_basename(captured, tmp_path):
    """The upload name is attacker-controlled text that becomes a path.

    `Path(...).name` is the whole defence, so it gets a test: the file must land inside the
    per-request staging directory and the recorded name must carry no separators.
    """
    client.post(
        "/api/v1/jobs",
        files={"files": ("../../../../etc/passwd.png", _png(), "image/png")},
    )
    job_input = captured[0]
    assert job_input.original_filenames == ["passwd.png"]
    assert "_uploads" in job_input.files[0].parts
    assert ".." not in job_input.files[0].parts


@pytest.mark.parametrize("filename", ["..", "."])
def test_a_filename_that_is_only_dots_becomes_a_real_name(captured, filename):
    """Regression: these two survive `.name` and are not filenames.

    `Path("..").name` is ".." and `Path(".").name` is "", so `staging / name` resolved to a
    *directory* — the ".." case escaping the staging directory entirely — and the write died
    with an unhandled IsADirectoryError. A one-character filename crashed the request.
    """
    response = client.post("/api/v1/jobs", files={"files": (filename, _png(), "image/png")})
    assert response.status_code == 200, response.text
    written = captured[0].files[0]
    assert written.name == "upload"
    assert written.is_file()


def test_two_uploads_with_the_same_name_are_both_kept(captured):
    """Regression: a name collision silently discarded one of the user's photos.

    Both files were written to the same path and `files` held that one path twice, so a
    photogrammetry job reconstructed N-1 distinct images with one of them counted twice — no
    error, no warning, just a worse reconstruction than the upload deserved. The display names
    stay as sent; only the on-disk paths are disambiguated.
    """
    response = client.post(
        "/api/v1/jobs",
        files=[
            ("files", ("IMG_0001.jpg", _png((255, 0, 0)), "image/jpeg")),
            ("files", ("IMG_0001.jpg", _png((0, 0, 255)), "image/jpeg")),
        ],
    )
    assert response.status_code == 200, response.text
    job_input = captured[0]
    assert job_input.original_filenames == ["IMG_0001.jpg", "IMG_0001.jpg"]
    assert len(set(job_input.files)) == 2, "one upload overwrote the other"
    assert all(p.is_file() for p in job_input.files)
    assert job_input.files[0].read_bytes() != job_input.files[1].read_bytes()
    assert job_input.source_type == "images"


def test_each_submission_gets_its_own_staging_directory(captured):
    """Two users uploading `photo.jpg` at the same moment must not collide either."""
    for _ in range(2):
        client.post("/api/v1/jobs", files={"files": ("photo.jpg", _png(), "image/jpeg")})
    first, second = captured[0].files[0], captured[1].files[0]
    assert first != second and first.parent != second.parent


# ── memory_refs parsing ───────────────────────────────────────────────────────────────────

def test_memory_refs_are_parsed_and_switch_the_job_origin(captured):
    client.post("/api/v1/jobs", data={"memory_refs": json.dumps(["mem_a", "mem_b"])})
    job_input = captured[0]
    assert job_input.memory_refs == ["mem_a", "mem_b"]
    assert job_input.origin == "memory"
    assert job_input.source_type == "images"  # two refs, no filenames to classify by


def test_uploaded_files_alongside_refs_keep_the_origin_as_upload(captured):
    """Files are the concrete input; the refs are provenance the asset should still record."""
    client.post(
        "/api/v1/jobs",
        files={"files": ("a.png", _png(), "image/png")},
        data={"memory_refs": json.dumps(["mem_a"])},
    )
    assert captured[0].origin == "upload"
    assert captured[0].memory_refs == ["mem_a"]


def test_malformed_memory_refs_json_is_a_400_not_a_crash():
    """Regression: an unguarded `json.loads` on a client-supplied form field.

    A typo'd or truncated value raised JSONDecodeError straight out of the handler — a 500 and
    a stack trace for what is plainly a bad request.
    """
    response = client.post("/api/v1/jobs", data={"memory_refs": "[not json"})
    assert response.status_code == 400
    assert "memory_refs" in response.json()["detail"]


@pytest.mark.parametrize("payload", ['"mem_a"', "42", '{"ref": "mem_a"}', "[1, 2]", "null"])
def test_valid_json_that_is_not_a_list_of_ids_is_a_400(payload):
    """Regression, and the nastier half of the same bug.

    `memory_refs='"mem_a"'` parses to the string "mem_a", which `for ref in refs` then iterates
    one CHARACTER at a time — five phantom memory lookups for 'm','e','m','_','a'. It was not
    an error anywhere; it was just wrong.
    """
    response = client.post("/api/v1/jobs", data={"memory_refs": payload})
    assert response.status_code == 400, response.text


def test_an_empty_submission_is_rejected():
    for data in ({}, {"memory_refs": "[]"}):
        response = client.post("/api/v1/jobs", data=data)
        assert response.status_code == 400
        assert "files or memory_refs" in response.json()["detail"]


# ── engine / model pass-through ───────────────────────────────────────────────────────────

def test_engine_and_model_reach_the_job_unmodified(captured):
    """The router owns interpreting these; the route must not pre-empt it."""
    client.post(
        "/api/v1/jobs",
        files={"files": ("a.png", _png(), "image/png")},
        data={"engine": "depth-image:midas-dpt-large", "model": "depth-pro", "format": "spz"},
    )
    job_input = captured[0]
    assert job_input.requested_engine == "depth-image:midas-dpt-large"
    assert job_input.requested_model == "depth-pro"
    assert job_input.requested_format == "spz"


def test_empty_engine_and_model_fields_become_none_rather_than_empty_strings(captured):
    """An HTML form posts "" for an untouched select, and "" is not a valid engine name."""
    client.post(
        "/api/v1/jobs",
        files={"files": ("a.png", _png(), "image/png")},
        data={"engine": "", "model": "", "format": ""},
    )
    job_input = captured[0]
    assert job_input.requested_engine is None
    assert job_input.requested_model is None
    assert job_input.requested_format is None


# ── job and asset delivery ────────────────────────────────────────────────────────────────

def _persist_asset(*, owner: str = OWNER, with_thumbnail: bool = True, tmp_path: Path) -> Asset:
    """Put a real asset in the app's own store, bypassing the engine entirely."""
    store = app.state.store
    master = tmp_path / "master.ply"
    master.write_bytes(b"ply\nformat binary_little_endian 1.0\nend_header\n")
    thumb = None
    if with_thumbnail:
        thumb = tmp_path / "thumb.webp"
        Image.new("RGB", (8, 8), (1, 2, 3)).save(thumb, "WEBP")

    asset = Asset(
        asset_id=f"a_test_{tmp_path.name}", owner=owner, kind="splat", engine="preview",
        source_type="image", source_origin="upload",
    )
    return store.persist_asset(
        asset,
        EngineResult(kind="splat", master_path=master, master_format="ply", thumbnail_path=thumb),
    )


def test_a_job_belonging_to_someone_else_is_a_404_not_a_403(tmp_path: Path):
    """Ownership is checked on read, and the code must not confirm the id exists.

    A 403 tells an unauthenticated prober that `job_xyz` is real; 404 tells them nothing. This
    is the only access-control decision in the REST layer.
    """
    app.state.store.save_job(Job(job_id="job_someone_else", owner="other@example.com",
                                 status="done"))
    assert client.get("/api/v1/jobs/job_someone_else").status_code == 404


def test_your_own_job_comes_back_with_its_fields(tmp_path: Path):
    app.state.store.save_job(Job(job_id="job_mine", owner=OWNER, status="done",
                                 engine="preview", message="done", asset_id="a_1"))
    body = client.get("/api/v1/jobs/job_mine").json()
    assert body["job_id"] == "job_mine"
    assert body["status"] == "done"
    assert body["engine"] == "preview"
    assert body["asset_id"] == "a_1"


def test_an_asset_is_listed_for_its_owner_and_readable_by_id(tmp_path: Path):
    asset = _persist_asset(tmp_path=tmp_path)
    listed = client.get("/api/v1/assets").json()["assets"]
    assert any(a["asset_id"] == asset.asset_id for a in listed)

    body = client.get(f"/api/v1/assets/{asset.asset_id}").json()
    assert body["kind"] == "splat"
    assert body["engine"] == "preview"
    assert "ply" in body["formats"]


def test_an_unknown_asset_is_a_404_everywhere(tmp_path: Path):
    for path in ("", "/file", "/thumbnail"):
        response = client.get(f"/api/v1/assets/a_nope{path}")
        assert response.status_code == 404, path


def test_the_default_download_format_is_the_master(tmp_path: Path):
    asset = _persist_asset(tmp_path=tmp_path)
    response = client.get(f"/api/v1/assets/{asset.asset_id}/file")
    assert response.status_code == 200
    assert response.content.startswith(b"ply\n")
    # The filename is what a browser saves; without the extension the viewer cannot open it.
    assert f"{asset.asset_id}.ply" in response.headers["content-disposition"]


def test_requesting_a_format_the_asset_does_not_have_names_the_format(tmp_path: Path):
    """Every client offers a format toggle, and spz is missing whenever the transcode failed."""
    asset = _persist_asset(tmp_path=tmp_path)
    response = client.get(f"/api/v1/assets/{asset.asset_id}/file", params={"format": "spz"})
    assert response.status_code == 404
    assert "spz" in response.json()["detail"]


def test_an_asset_with_no_formats_says_so_rather_than_serving_nothing(tmp_path: Path):
    asset = _persist_asset(tmp_path=tmp_path)
    asset.formats = {}
    app.state.store.save_asset_metadata(asset)
    response = client.get(f"/api/v1/assets/{asset.asset_id}/file")
    assert response.status_code == 404
    assert "no downloadable formats" in response.json()["detail"]


def test_a_thumbnail_is_served_as_webp_and_absent_when_never_made(tmp_path: Path):
    """`make_thumbnail` swallows every failure and returns None, so "no thumbnail" is a normal
    state for a real asset, not a corrupt one."""
    with_thumb = _persist_asset(tmp_path=tmp_path)
    response = client.get(f"/api/v1/assets/{with_thumb.asset_id}/thumbnail")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/webp"

    bare_dir = tmp_path / "bare"
    bare_dir.mkdir()
    without = _persist_asset(with_thumbnail=False, tmp_path=bare_dir)
    assert client.get(f"/api/v1/assets/{without.asset_id}/thumbnail").status_code == 404


def test_another_owners_assets_are_not_in_your_list(tmp_path: Path):
    other_dir = tmp_path / "other"
    other_dir.mkdir()
    theirs = _persist_asset(owner="other@example.com", tmp_path=other_dir)
    listed = {a["asset_id"] for a in client.get("/api/v1/assets").json()["assets"]}
    assert theirs.asset_id not in listed


# ── memory browsing ───────────────────────────────────────────────────────────────────────

def test_browsing_memory_with_memory_disabled_returns_an_empty_list_not_an_error():
    """CI_MEMORY_MCP_URL is empty in most deployments, and the client calls this on page load.

    Every memory call is best-effort by design, so the endpoint must answer 200 with nothing
    rather than making the gallery look broken.
    """
    response = client.get("/api/v1/memory/media")
    assert response.status_code == 200
    assert response.json() == {"media": []}


@pytest.mark.parametrize("media_type", ["image", "video"])
def test_the_media_type_filter_is_accepted(media_type):
    response = client.get("/api/v1/memory/media", params={"type": media_type})
    assert response.status_code == 200
