"""Agent-facing MCP server.

Exposes the app's capabilities as MCP tools so Companion agents (Hermes, OpenClaw, Claude
Code) can create and share 3D assets — including turning a photo/video that already lives in
Companion memory into an explorable splat. Built lazily so the REST API runs even if the
optional ``mcp`` package isn't installed.
"""

from __future__ import annotations

from typing import Optional

from .config import Settings
from .jobs import JobManager
from .models import JobInput
from .routes import _classify
from .storage import Store


def _default_owner(settings: Settings) -> str:
    return "dev@local" if settings.auth_disabled else "agent@companion"


def build_mcp(jobs: JobManager, store: Store, settings: Settings):
    """Create the FastMCP app, or return None if the mcp package is unavailable."""
    try:
        from mcp.server.fastmcp import FastMCP
        from mcp.server.transport_security import TransportSecuritySettings
    except Exception as exc:  # noqa: BLE001
        # Log it. This used to swallow the reason, and when `mcp` 2.0 renamed FastMCP to
        # MCPServer the only trace of a completely absent MCP surface was a line claiming
        # the package was "not installed" — while it was installed and importable.
        import logging

        logging.getLogger("ptm").warning("MCP surface unavailable: %s: %s", type(exc).__name__, exc)
        return None

    # Hand FastMCP an explicit allowlist. Left to itself it derives a loopback-only one from
    # its (unused) bind host, and behind a reverse proxy — which is every deployment — the
    # inbound Host is the public name, so every agent request gets 421. See
    # Settings.mcp_host_allowlist.
    mcp = FastMCP(
        "photo-time-machine",
        streamable_http_path="/",
        transport_security=TransportSecuritySettings(
            enable_dns_rebinding_protection=True,
            allowed_hosts=settings.mcp_host_allowlist,
            allowed_origins=settings.mcp_origin_allowlist,
        ),
    )
    owner = _default_owner(settings)

    @mcp.tool()
    def list_engines() -> list[dict]:
        """List available 3D engines and what inputs/outputs each supports."""
        return [c.model_dump() for c in jobs.registry.capabilities(settings)]

    @mcp.tool()
    def image_to_3d(source: str, intent: str = "auto", engine: Optional[str] = None) -> dict:
        """Turn a single image into a 3D asset.

        `source` is an image URL or a Companion-memory ref. `intent` is 'object' (full 3D
        object), 'scene' (monocular scene/portal), or 'auto'. Returns a job; poll get_job.
        """
        job = jobs.create_job(JobInput(
            owner=owner, source_type="image", origin="memory", memory_refs=[source],
            intent=intent if intent in ("auto", "object", "scene") else "auto",  # type: ignore[arg-type]
            requested_engine=engine or None,
        ))
        return job.model_dump(mode="json")

    @mcp.tool()
    def media_to_3d(sources: list[str], intent: str = "auto", engine: Optional[str] = None) -> dict:
        """Turn multiple images or a video (URLs or memory refs) into a reconstructed 3D scene."""
        st = _classify(sources)
        job = jobs.create_job(JobInput(
            owner=owner, source_type=st, origin="memory", memory_refs=sources,
            intent=intent if intent in ("auto", "object", "scene") else "auto",  # type: ignore[arg-type]
            requested_engine=engine or None,
        ))
        return job.model_dump(mode="json")

    @mcp.tool()
    def get_job(job_id: str) -> dict:
        """Poll a job's status. When status is 'done', `asset_id` is populated."""
        job = store.get_job(job_id)
        return job.model_dump(mode="json") if job else {"error": "not found"}

    @mcp.tool()
    def list_assets() -> list[dict]:
        """List created 3D assets with their share URLs."""
        return [a.model_dump(mode="json") for a in store.list_assets(owner)]

    @mcp.tool()
    def get_asset(asset_id: str) -> dict:
        """Get full metadata for one asset, including share_url and available formats."""
        asset = store.get_asset(asset_id)
        return asset.model_dump(mode="json") if asset else {"error": "not found"}

    @mcp.tool()
    def get_share_url(asset_id: str) -> dict:
        """Get the public /view/:assetId share link for an asset."""
        asset = store.get_asset(asset_id)
        if not asset:
            return {"error": "not found"}
        return {"asset_id": asset_id, "share_url": asset.share_url}

    return mcp
