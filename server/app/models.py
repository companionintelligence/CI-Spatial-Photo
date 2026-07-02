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
