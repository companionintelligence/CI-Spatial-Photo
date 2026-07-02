"""End-to-end job pipeline on CPU: image -> preview engine -> persisted splat asset."""

import asyncio
from pathlib import Path

import pytest
from PIL import Image

from app.config import Settings
from app.jobs import JobManager
from app.models import JobInput
from app.storage import Store


async def _wait(store: Store, job_id: str, timeout: float = 15.0):
    elapsed = 0.0
    while elapsed < timeout:
        job = store.get_job(job_id)
        if job and job.status in ("done", "error"):
            return job
        await asyncio.sleep(0.05)
        elapsed += 0.05
    raise TimeoutError("job did not finish")


@pytest.mark.asyncio
async def test_image_to_splat_pipeline(tmp_path: Path):
    img = tmp_path / "cat.jpg"
    Image.new("RGB", (80, 60), (200, 100, 50)).save(img)

    settings = Settings(asset_dir=tmp_path / "assets", auth_disabled=True, ci_memory_mcp_url="")
    store = Store(settings.asset_dir)
    jm = JobManager(store, settings)

    job = jm.create_job(JobInput(
        owner="dev@local", source_type="image", files=[img], original_filenames=["cat.jpg"],
    ))
    finished = await _wait(store, job.job_id)

    assert finished.status == "done", finished.error
    assert finished.engine == "preview"
    asset = store.get_asset(finished.asset_id)
    assert asset is not None
    assert asset.kind == "splat"
    assert "ply" in asset.formats
    assert "spz" in asset.formats, "splat assets should get a compressed spz for sharing"
    assert asset.share_url.endswith(f"/view/{asset.asset_id}")
    assert store.asset_file(asset.asset_id, "ply").exists()
    spz_file = store.asset_file(asset.asset_id, "spz")
    assert spz_file.exists()
    assert spz_file.stat().st_size < store.asset_file(asset.asset_id, "ply").stat().st_size
    # listed for the owner
    assert any(a.asset_id == asset.asset_id for a in store.list_assets("dev@local"))
