"""Asynchronous job manager.

Uploads/requests return immediately with a ``job_id``; the actual (possibly GPU-heavy) engine
work runs in a background task on a worker thread so it never blocks the event loop. On success
the asset is persisted and recorded to Companion memory.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
from datetime import datetime, timezone
from pathlib import Path

from .config import Settings
from .engines import EngineError, get_registry
from .memory import MemoryClient
from .models import Asset, EngineResult, Job, JobInput
from .storage import Store
from .transcode import ply_to_spz

log = logging.getLogger("ptm.jobs")


def _new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(8)}"


class JobManager:
    def __init__(self, store: Store, settings: Settings):
        self.store = store
        self.settings = settings
        self.registry = get_registry()
        self.memory = MemoryClient(settings)
        self._inputs: dict[str, JobInput] = {}

    def _workdir(self, job_id: str) -> Path:
        d = self.settings.asset_dir / "_work" / job_id
        d.mkdir(parents=True, exist_ok=True)
        return d

    def create_job(self, job_input: JobInput) -> Job:
        job = Job(job_id=_new_id("job"), owner=job_input.owner, status="queued")
        self._inputs[job.job_id] = job_input
        self.store.save_job(job)
        asyncio.create_task(self._run(job.job_id))
        return job

    def _touch(self, job: Job, **fields) -> None:
        for k, v in fields.items():
            setattr(job, k, v)
        job.updated_at = datetime.now(timezone.utc)
        self.store.save_job(job)

    def _transcode(self, result: EngineResult, workdir: Path) -> None:
        """Produce compressed delivery formats next to the master. Best-effort: a transcode
        failure must never fail the job — the master format is always served."""
        if result.kind == "splat" and result.master_format == "ply" and "spz" not in result.extra_files:
            try:
                spz = workdir / "model.spz"
                ply_to_spz(result.master_path, spz)
                result.extra_files["spz"] = spz
            except Exception as e:  # noqa: BLE001
                log.warning("spz transcode failed: %s", e)

    async def _run(self, job_id: str) -> None:
        job = self.store.get_job(job_id)
        job_input = self._inputs.get(job_id)
        if not job or not job_input:
            return
        self._touch(job, status="running", message="preparing input")
        workdir = self._workdir(job_id)
        try:
            if job_input.origin == "memory":
                files: list[Path] = []
                for ref in job_input.memory_refs:
                    files.append(await self.memory.download_media(ref, workdir / "input"))
                if not files:
                    raise EngineError("No media could be pulled from Companion memory.")
                job_input.files = files
                if not job_input.original_filenames:
                    job_input.original_filenames = [f.name for f in files]

            engine = self.registry.route(job_input, self.settings)
            # Engines that wrap several checkpoints report which one this job will use, so the
            # progress line and the stored asset both name it. None for single-model engines.
            engine_model = engine.resolve_model(job_input, self.settings)
            # The client renders "Status: {status} — {message}", so a message that
            # opens with the status word stutters: with the CPU preview engine this
            # read "Status: running — running preview". Name the phase, not the state.
            label = f"{engine.name} ({engine_model})" if engine_model else engine.name
            self._touch(job, engine=engine.name, message=f"reconstructing with {label}")

            result = await asyncio.to_thread(engine.run, job_input, workdir, self.settings)

            self._touch(job, message="transcoding")
            await asyncio.to_thread(self._transcode, result, workdir)

            asset = Asset(
                asset_id=_new_id("a"),
                owner=job_input.owner,
                kind=result.kind,
                engine=engine.name,
                engine_model=engine_model,
                source_type=job_input.source_type,
                source_origin=job_input.origin,
                source_filenames=job_input.original_filenames,
                source_memory_refs=job_input.memory_refs,
                tags=["3d", result.kind, engine.name] + ([engine_model] if engine_model else []),
            )
            asset.share_url = self.settings.share_url(asset.asset_id)
            asset = self.store.persist_asset(asset, result)

            self._touch(job, message="recording to memory")
            try:
                asset.memory_id = await self.memory.record_asset(asset)
                self.store.save_asset_metadata(asset)
            except Exception as e:  # noqa: BLE001 — memory is best-effort
                log.warning("memory record failed for %s: %s", asset.asset_id, e)

            self._touch(job, status="done", message="done", asset_id=asset.asset_id)
        except EngineError as e:
            self._touch(job, status="error", error=str(e), message="failed")
        except Exception as e:  # noqa: BLE001
            log.exception("job %s crashed", job_id)
            self._touch(job, status="error", error=f"internal error: {e}", message="failed")
        finally:
            self._inputs.pop(job_id, None)
