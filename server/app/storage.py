"""Filesystem-backed store for jobs and assets.

Layout under ``ASSET_DIR``::

    jobs/<job_id>.json
    assets/<asset_id>/metadata.json
    assets/<asset_id>/master.ply | master.glb | model.spz | thumb.webp | ...

Single-process, single-node store. Swap for a DB + object store when scaling out; the
public methods here are the seam.
"""

from __future__ import annotations

import shutil
import threading
from pathlib import Path
from typing import Optional

from .models import Asset, EngineResult, Job


class Store:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.jobs_dir = self.root / "jobs"
        self.assets_dir = self.root / "assets"
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        self.assets_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    # ── Jobs ──────────────────────────────────────────────────────────────────
    def save_job(self, job: Job) -> None:
        with self._lock:
            (self.jobs_dir / f"{job.job_id}.json").write_text(job.model_dump_json(indent=2))

    def get_job(self, job_id: str) -> Optional[Job]:
        path = self.jobs_dir / f"{job_id}.json"
        if not path.exists():
            return None
        return Job.model_validate_json(path.read_text())

    # ── Assets ────────────────────────────────────────────────────────────────
    def asset_dir(self, asset_id: str) -> Path:
        return self.assets_dir / asset_id

    def persist_asset(self, asset: Asset, result: EngineResult) -> Asset:
        """Copy an engine's output files into the asset directory and record formats."""
        adir = self.asset_dir(asset.asset_id)
        adir.mkdir(parents=True, exist_ok=True)

        formats: dict[str, str] = {}
        master_name = f"master.{result.master_format}"
        shutil.copy2(result.master_path, adir / master_name)
        formats[result.master_format] = master_name

        for fmt, src in result.extra_files.items():
            dest_name = f"model.{fmt}"
            shutil.copy2(src, adir / dest_name)
            formats[fmt] = dest_name

        if result.thumbnail_path and Path(result.thumbnail_path).exists():
            shutil.copy2(result.thumbnail_path, adir / "thumb.webp")
            asset.thumbnail = "thumb.webp"

        asset.formats = formats
        asset.temporal = result.temporal
        (adir / "metadata.json").write_text(asset.model_dump_json(indent=2))
        return asset

    def save_asset_metadata(self, asset: Asset) -> None:
        adir = self.asset_dir(asset.asset_id)
        adir.mkdir(parents=True, exist_ok=True)
        (adir / "metadata.json").write_text(asset.model_dump_json(indent=2))

    def get_asset(self, asset_id: str) -> Optional[Asset]:
        path = self.asset_dir(asset_id) / "metadata.json"
        if not path.exists():
            return None
        return Asset.model_validate_json(path.read_text())

    def list_assets(self, owner: Optional[str] = None) -> list[Asset]:
        assets: list[Asset] = []
        for meta in self.assets_dir.glob("*/metadata.json"):
            try:
                asset = Asset.model_validate_json(meta.read_text())
            except Exception:
                continue
            if owner is None or asset.owner == owner:
                assets.append(asset)
        assets.sort(key=lambda a: a.created_at, reverse=True)
        return assets

    def asset_file(self, asset_id: str, fmt: str) -> Optional[Path]:
        asset = self.get_asset(asset_id)
        if not asset or fmt not in asset.formats:
            return None
        path = self.asset_dir(asset_id) / asset.formats[fmt]
        return path if path.exists() else None

    def thumbnail_file(self, asset_id: str) -> Optional[Path]:
        asset = self.get_asset(asset_id)
        if not asset or not asset.thumbnail:
            return None
        path = self.asset_dir(asset_id) / asset.thumbnail
        return path if path.exists() else None
