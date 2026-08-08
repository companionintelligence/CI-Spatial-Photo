"""The job manager's failure handling — the half of `_run` the happy path never touches.

`test_pipeline.py` proves an image becomes an asset. Everything here is about what happens when
a step does *not* work, because the job manager makes a different promise for each one:

* the engine failing        -> the job goes to `error` carrying the engine's own message
* anything else failing     -> the job goes to `error` labelled an internal error, never hangs
* the transcode failing     -> best effort, the job still succeeds with the master format
* the memory write failing  -> best effort, the asset is still created and listed

A job stuck in `running` forever is the worst outcome of the four and the one no assertion
about the happy path can catch, so every test here drives a real job to a terminal state.
"""

import asyncio
from pathlib import Path

import pytest
from PIL import Image

from app.config import Settings
from app.engines import EngineError
from app.jobs import JobManager
from app.models import EngineResult, JobInput
from app.storage import Store


def _settings(tmp_path: Path, **kw) -> Settings:
    base = dict(
        asset_dir=tmp_path / "assets",
        auth_disabled=True,
        ci_memory_mcp_url="",
        default_engine="preview",
    )
    base.update(kw)
    return Settings(**base)


def _manager(tmp_path: Path, **kw) -> tuple[JobManager, Store]:
    settings = _settings(tmp_path, **kw)
    store = Store(settings.asset_dir)
    return JobManager(store, settings), store


def _image(path: Path, size=(48, 36)) -> Path:
    Image.new("RGB", size, (200, 100, 50)).save(path)
    return path


async def _finished(store: Store, job_id: str, timeout: float = 20.0):
    """Drive the event loop until the background task reaches a terminal state."""
    waited = 0.0
    while waited < timeout:
        job = store.get_job(job_id)
        if job and job.status in ("done", "error"):
            return job
        await asyncio.sleep(0.02)
        waited += 0.02
    raise TimeoutError(f"job {job_id} never left {store.get_job(job_id).status!r}")


# ── engine failures ───────────────────────────────────────────────────────────────────────

async def test_an_engine_error_reaches_the_user_verbatim(tmp_path: Path):
    """Engine messages name the missing binary or the env var; the manager must not paraphrase."""
    manager, store = _manager(tmp_path)
    job = manager.create_job(JobInput(
        owner="dev@local", source_type="image", files=[_image(tmp_path / "a.png")],
        requested_engine="sharp",
    ))
    finished = await _finished(store, job.job_id)
    assert finished.status == "error"
    assert "SHARP_ENABLE_RESEARCH" in finished.error
    assert finished.message == "failed"


async def test_an_unexpected_exception_is_labelled_internal_and_still_terminates(tmp_path: Path):
    """A bug in an engine must fail the job, not leave it `running` until the process dies.

    Engines run through `asyncio.to_thread`, so an exception that is not an EngineError arrives
    on a worker thread with no other handler above it. The distinct "internal error:" prefix is
    what separates "you configured something wrong" from "we have a bug" in a support thread.
    """
    manager, store = _manager(tmp_path)
    preview = manager.registry.get("preview")
    original = preview.run

    def explode(job_input, workdir, settings):
        raise ZeroDivisionError("division by zero")

    preview.run = explode
    try:
        job = manager.create_job(JobInput(
            owner="dev@local", source_type="image", files=[_image(tmp_path / "a.png")],
        ))
        finished = await _finished(store, job.job_id)
    finally:
        preview.run = original

    assert finished.status == "error"
    assert finished.error.startswith("internal error:")
    assert "division by zero" in finished.error


async def test_a_job_whose_input_was_forgotten_exits_quietly(tmp_path: Path):
    """`_run` is scheduled by id, so the input can be gone by the time it runs (or never
    existed). Returning is correct; raising would surface as an unretrievable task exception."""
    manager, _store = _manager(tmp_path)
    await manager._run("job_does_not_exist")  # must not raise


async def test_the_input_is_dropped_once_the_job_finishes(tmp_path: Path):
    """`_inputs` holds the uploaded file list for every job; never clearing it is a slow leak."""
    manager, store = _manager(tmp_path)
    job = manager.create_job(JobInput(
        owner="dev@local", source_type="image", files=[_image(tmp_path / "a.png")],
    ))
    await _finished(store, job.job_id)
    assert job.job_id not in manager._inputs


# ── transcoding is best effort ────────────────────────────────────────────────────────────

def test_an_unreadable_master_ply_does_not_fail_the_job(tmp_path: Path):
    """spz is a delivery convenience; the master PLY is always served, so a transcode failure
    must be a log line and nothing more."""
    manager, _store = _manager(tmp_path)
    broken = tmp_path / "master.ply"
    broken.write_bytes(b"this is not a ply at all")
    result = EngineResult(kind="splat", master_path=broken, master_format="ply")

    manager._transcode(result, tmp_path)  # must not raise
    assert "spz" not in result.extra_files


@pytest.mark.parametrize(
    "kind, master_format",
    [("mesh", "glb"), ("splat", "spz"), ("mesh", "ply")],
)
def test_the_transcode_only_touches_a_splat_whose_master_is_a_ply(tmp_path, kind, master_format):
    """The reader only understands 3DGS PLY; pointing it at a GLB would raise on every job."""
    manager, _store = _manager(tmp_path)
    master = tmp_path / f"master.{master_format}"
    master.write_bytes(b"\x00")
    result = EngineResult(kind=kind, master_path=master, master_format=master_format)
    manager._transcode(result, tmp_path)
    assert "spz" not in result.extra_files


def test_an_engine_supplied_spz_is_not_overwritten(tmp_path: Path):
    """An engine that already emits spz knows more about its own cloud than the transcoder."""
    manager, _store = _manager(tmp_path)
    master = tmp_path / "master.ply"
    master.write_bytes(b"not a ply")
    theirs = tmp_path / "theirs.spz"
    theirs.write_bytes(b"\x00")
    result = EngineResult(
        kind="splat", master_path=master, master_format="ply", extra_files={"spz": theirs}
    )
    manager._transcode(result, tmp_path)
    assert result.extra_files["spz"] == theirs


# ── memory is best effort ─────────────────────────────────────────────────────────────────

async def test_a_failing_memory_write_still_produces_a_usable_asset(tmp_path: Path):
    """Companion memory being down must never cost the user the 3D asset they just waited for."""
    manager, store = _manager(tmp_path)

    async def refuse(asset):
        raise RuntimeError("memory MCP unreachable")

    manager.memory.record_asset = refuse
    job = manager.create_job(JobInput(
        owner="dev@local", source_type="image", files=[_image(tmp_path / "a.png")],
    ))
    finished = await _finished(store, job.job_id)

    assert finished.status == "done", finished.error
    asset = store.get_asset(finished.asset_id)
    assert asset is not None and asset.memory_id is None
    assert "ply" in asset.formats


async def test_a_successful_memory_write_is_persisted_onto_the_asset(tmp_path: Path):
    """The id is written to the asset *after* it is persisted, so it needs a second save —
    an easy step to lose, and it only shows up as a missing back-link days later."""
    manager, store = _manager(tmp_path)

    async def record(asset):
        return "mem_12345"

    manager.memory.record_asset = record
    job = manager.create_job(JobInput(
        owner="dev@local", source_type="image", files=[_image(tmp_path / "a.png")],
    ))
    finished = await _finished(store, job.job_id)
    assert finished.status == "done", finished.error
    assert store.get_asset(finished.asset_id).memory_id == "mem_12345"


# ── memory as an input source ─────────────────────────────────────────────────────────────

async def test_a_memory_job_with_nothing_downloadable_fails_with_a_readable_message(tmp_path):
    """No refs, or refs that all fail to resolve, must not reach an engine with an empty list.

    Preview's own error for that is "Preview engine needs one image", which sends the user
    looking at the wrong end of the pipeline entirely.
    """
    manager, store = _manager(tmp_path)
    job = manager.create_job(JobInput(
        owner="dev@local", source_type="image", origin="memory", memory_refs=[],
    ))
    finished = await _finished(store, job.job_id)
    assert finished.status == "error"
    assert "Companion memory" in finished.error


async def test_memory_media_is_downloaded_and_named_before_routing(tmp_path: Path):
    """`original_filenames` is the only human-readable trace of what a memory job was made from.

    It is also what `_classify`-equivalent decisions downstream read, so an empty list turns a
    remembered video into "image" and routes it to the wrong engine.
    """
    manager, store = _manager(tmp_path)
    downloaded: list[str] = []

    async def fake_download(ref: str, dest_dir: Path) -> Path:
        downloaded.append(ref)
        dest_dir.mkdir(parents=True, exist_ok=True)
        return _image(dest_dir / f"{ref}.png")

    manager.memory.download_media = fake_download
    job = manager.create_job(JobInput(
        owner="dev@local", source_type="image", origin="memory", memory_refs=["mem_a"],
    ))
    finished = await _finished(store, job.job_id)

    assert finished.status == "done", finished.error
    assert downloaded == ["mem_a"]
    asset = store.get_asset(finished.asset_id)
    assert asset.source_filenames == ["mem_a.png"]
    assert asset.source_memory_refs == ["mem_a"]
    assert asset.source_origin == "memory"


async def test_a_download_failure_is_reported_as_an_internal_error_not_a_hang(tmp_path: Path):
    """`download_media` raises ValueError for an unresolvable ref and httpx errors for a dead
    host — neither is an EngineError, so this is the catch-all's job."""
    manager, store = _manager(tmp_path)

    async def fail(ref: str, dest_dir: Path) -> Path:
        raise ValueError(f"Could not resolve memory ref '{ref}' to a media URL.")

    manager.memory.download_media = fail
    job = manager.create_job(JobInput(
        owner="dev@local", source_type="image", origin="memory", memory_refs=["mem_gone"],
    ))
    finished = await _finished(store, job.job_id)
    assert finished.status == "error"
    assert "mem_gone" in finished.error


# ── bookkeeping ───────────────────────────────────────────────────────────────────────────

async def test_the_asset_records_what_produced_it(tmp_path: Path):
    """Provenance is the point of writing these back to memory; it has to survive the job."""
    manager, store = _manager(tmp_path)
    job = manager.create_job(JobInput(
        owner="dev@local", source_type="image", files=[_image(tmp_path / "cat.png")],
        original_filenames=["cat.png"],
    ))
    finished = await _finished(store, job.job_id)
    asset = store.get_asset(finished.asset_id)

    assert asset.owner == "dev@local"
    assert asset.engine == "preview"
    assert asset.engine_model is None, "single-model engines must not invent a checkpoint id"
    assert asset.source_type == "image"
    assert asset.source_origin == "upload"
    assert asset.source_filenames == ["cat.png"]
    assert set(asset.tags) >= {"3d", "splat", "preview"}
    assert asset.share_url.endswith(f"/view/{asset.asset_id}")


async def test_the_progress_message_never_stutters_the_status_word(tmp_path: Path):
    """The client renders "Status: {status} — {message}".

    A message that opens with the status word produced "Status: running — running preview" on
    every CPU job. The message names the phase; the status names the state.
    """
    manager, store = _manager(tmp_path)
    seen: list[str] = []
    original_touch = manager._touch

    def spy(job, **fields):
        original_touch(job, **fields)
        if job.message:
            seen.append(job.message)

    manager._touch = spy
    job = manager.create_job(JobInput(
        owner="dev@local", source_type="image", files=[_image(tmp_path / "a.png")],
    ))
    await _finished(store, job.job_id)

    assert seen, "the job reported no progress at all"
    assert any(m.startswith("reconstructing with preview") for m in seen)
    for message in seen:
        assert not message.startswith(("running", "queued")), message


async def test_two_jobs_get_distinct_ids_and_workdirs(tmp_path: Path):
    """Concurrent uploads share one asset_dir; a collision would have one job overwrite the
    other's master.ply between the engine writing it and the store copying it."""
    manager, store = _manager(tmp_path)
    jobs = [
        manager.create_job(JobInput(
            owner="dev@local", source_type="image", files=[_image(tmp_path / f"{i}.png")],
        ))
        for i in range(3)
    ]
    ids = {j.job_id for j in jobs}
    assert len(ids) == 3
    assert len({str(manager._workdir(i)) for i in ids}) == 3

    finished = [await _finished(store, j.job_id) for j in jobs]
    assert all(f.status == "done" for f in finished), [f.error for f in finished]
    assert len({f.asset_id for f in finished}) == 3


def test_engine_error_is_what_the_manager_catches_by_name():
    """Guard against `EngineError` being re-exported from somewhere else and drifting: the
    manager's `except EngineError` and the engines' raise have to be the same class."""
    from app.engines.base import EngineError as BaseEngineError

    assert EngineError is BaseEngineError
