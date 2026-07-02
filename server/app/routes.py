"""Browser-facing REST API (mounted at /api/v1)."""

from __future__ import annotations

import json
import secrets
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from .auth import Principal, require_principal
from .config import Settings, get_settings
from .models import Job, JobInput, SourceType

router = APIRouter(prefix="/api/v1")

VIDEO_EXT = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".bmp", ".tif", ".tiff"}


def _classify(filenames: list[str]) -> SourceType:
    if any(Path(n).suffix.lower() in VIDEO_EXT for n in filenames):
        return "video"
    return "images" if len(filenames) > 1 else "image"


def _jobs(request: Request):
    return request.app.state.jobs


def _store(request: Request):
    return request.app.state.store


@router.get("/engines")
def list_engines(
    request: Request,
    _: Principal = Depends(require_principal),
    settings: Settings = Depends(get_settings),
):
    return {"engines": [c.model_dump() for c in _jobs(request).registry.capabilities(settings)]}


@router.post("/jobs", response_model=Job)
async def create_job(
    request: Request,
    files: list[UploadFile] = File(default=[]),
    engine: Optional[str] = Form(default=None),
    intent: str = Form(default="auto"),
    format: Optional[str] = Form(default=None),
    memory_refs: Optional[str] = Form(default=None),
    source_type: Optional[str] = Form(default=None),
    principal: Principal = Depends(require_principal),
    settings: Settings = Depends(get_settings),
):
    refs: list[str] = json.loads(memory_refs) if memory_refs else []
    if not files and not refs:
        raise HTTPException(400, "Provide one or more files or memory_refs.")

    saved: list[Path] = []
    names: list[str] = []
    if files:
        staging = settings.asset_dir / "_uploads" / secrets.token_hex(8)
        staging.mkdir(parents=True, exist_ok=True)
        for uf in files:
            name = Path(uf.filename or "upload").name
            dest = staging / name
            dest.write_bytes(await uf.read())
            saved.append(dest)
            names.append(name)

    origin = "memory" if (refs and not files) else "upload"
    st: SourceType = source_type if source_type in ("image", "images", "video") else _classify(names or refs)  # type: ignore[assignment]

    job_input = JobInput(
        owner=principal.owner_key,
        source_type=st,
        files=saved,
        original_filenames=names,
        origin=origin,
        memory_refs=refs,
        intent=intent if intent in ("auto", "object", "scene") else "auto",  # type: ignore[arg-type]
        requested_engine=engine or None,
        requested_format=format or None,
    )
    return _jobs(request).create_job(job_input)


@router.get("/jobs/{job_id}", response_model=Job)
def get_job(job_id: str, request: Request, principal: Principal = Depends(require_principal)):
    job = _store(request).get_job(job_id)
    if not job or job.owner != principal.owner_key:
        raise HTTPException(404, "Job not found")
    return job


@router.get("/assets")
def list_assets(request: Request, principal: Principal = Depends(require_principal)):
    return {"assets": [a.model_dump(mode="json") for a in _store(request).list_assets(principal.owner_key)]}


@router.get("/assets/{asset_id}")
def get_asset(asset_id: str, request: Request, principal: Principal = Depends(require_principal)):
    asset = _store(request).get_asset(asset_id)
    if not asset:
        raise HTTPException(404, "Asset not found")
    return asset.model_dump(mode="json")


@router.get("/assets/{asset_id}/file")
def get_asset_file(
    asset_id: str,
    request: Request,
    format: Optional[str] = None,
    _: Principal = Depends(require_principal),
):
    store = _store(request)
    asset = store.get_asset(asset_id)
    if not asset:
        raise HTTPException(404, "Asset not found")
    fmt = format or next(iter(asset.formats), None)
    if not fmt:
        raise HTTPException(404, "Asset has no downloadable formats")
    path = store.asset_file(asset_id, fmt)
    if not path:
        raise HTTPException(404, f"Format '{fmt}' not available")
    return FileResponse(path, filename=f"{asset_id}.{fmt}")


@router.get("/assets/{asset_id}/thumbnail")
def get_thumbnail(asset_id: str, request: Request, _: Principal = Depends(require_principal)):
    path = _store(request).thumbnail_file(asset_id)
    if not path:
        raise HTTPException(404, "No thumbnail")
    return FileResponse(path, media_type="image/webp")


@router.get("/memory/media")
async def list_memory_media(
    request: Request,
    type: str = "image",
    principal: Principal = Depends(require_principal),
):
    """List the user's photos/videos in Companion memory, to turn into splats."""
    media = await _jobs(request).memory.list_media(principal.owner_key, media_type=type)
    return {"media": [m.model_dump(mode="json") for m in media]}
