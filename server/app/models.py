"""Pydantic models shared across storage, jobs, REST, and MCP surfaces."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel, Field

SourceType = Literal["image", "images", "video"]
SourceOrigin = Literal["upload", "memory"]
Intent = Literal["auto", "object", "scene"]
AssetKind = Literal["splat", "mesh"]
JobStatus = Literal["queued", "running", "done", "error"]


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class JobInput(BaseModel):
    """Everything an engine needs to produce an asset.

    Media is always localized to files on disk before an engine runs, regardless of whether
    it was uploaded or pulled from Companion memory.
    """

    owner: str
    source_type: SourceType
    files: list[Path] = Field(default_factory=list)
    original_filenames: list[str] = Field(default_factory=list)
    origin: SourceOrigin = "upload"
    memory_refs: list[str] = Field(default_factory=list)
    intent: Intent = "auto"
    requested_engine: Optional[str] = None
    requested_format: Optional[str] = None
    # Which checkpoint to run *inside* the chosen engine (see EngineCapabilities.models).
    # Optional and ignored by engines that expose a single model, so every pre-existing caller
    # — including the MCP tools, which have no model argument — keeps working untouched.
    requested_model: Optional[str] = None


class EngineModelInfo(BaseModel):
    """One selectable checkpoint within an engine.

    Engines that wrap a family of interchangeable weights (the depth engines) advertise them
    here instead of registering one engine per checkpoint. Splitting them would have put six
    near-identical rows in the client's engine dropdown and made ``available`` on the engine
    meaningless — the small model can be ready while the large one is a 1.3 GB download away.
    """

    id: str
    label: str
    description: str = ""
    license: str = ""
    commercial: bool = True
    requires_gpu: bool = False
    temporal: bool = False           # the checkpoint itself is temporally consistent
    approx_download_mb: Optional[int] = None
    weights_cached: bool = False     # a local snapshot exists; no download needed on first run
    available: bool = True
    unavailable_reason: Optional[str] = None


class EngineCapabilities(BaseModel):
    name: str
    description: str
    inputs: list[SourceType]
    intents: list[Intent]
    output_kind: AssetKind
    output_formats: list[str]
    commercial: bool
    requires_gpu: bool
    license: str
    available: bool = True
    unavailable_reason: Optional[str] = None
    # Additive and defaulted: single-model engines emit an empty list and a null default, so
    # the payload shape older clients parse is unchanged.
    models: list[EngineModelInfo] = Field(default_factory=list)
    default_model: Optional[str] = None


class EngineResult(BaseModel):
    """What an engine returns to the job manager for persistence."""

    kind: AssetKind
    master_path: Path
    master_format: str
    extra_files: dict[str, Path] = Field(default_factory=dict)
    thumbnail_path: Optional[Path] = None
    temporal: bool = False


class Asset(BaseModel):
    asset_id: str
    owner: str
    kind: AssetKind
    engine: str
    # Checkpoint the engine actually ran, when it has a choice. Recorded because "made with
    # depth-image" is not reproducible information — the small and large Depth Anything
    # checkpoints produce visibly different geometry from the same photo.
    engine_model: Optional[str] = None
    source_type: SourceType
    source_origin: SourceOrigin = "upload"
    source_filenames: list[str] = Field(default_factory=list)
    source_memory_refs: list[str] = Field(default_factory=list)
    temporal: bool = False
    formats: dict[str, str] = Field(default_factory=dict)  # e.g. {"ply": "master.ply", "spz": "..."}
    thumbnail: Optional[str] = None
    share_url: str = ""
    created_at: datetime = Field(default_factory=_utcnow)
    tags: list[str] = Field(default_factory=list)
    memory_id: Optional[str] = None  # id returned by Companion memory, if written back


class Job(BaseModel):
    job_id: str
    owner: str
    status: JobStatus = "queued"
    engine: Optional[str] = None
    message: str = "queued"
    error: Optional[str] = None
    asset_id: Optional[str] = None
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)


class MemoryMedia(BaseModel):
    """A photo/video available in Companion memory that can be turned into a splat."""

    ref: str
    kind: Literal["image", "video"]
    title: Optional[str] = None
    thumbnail_url: Optional[str] = None
    created_at: Optional[datetime] = None
