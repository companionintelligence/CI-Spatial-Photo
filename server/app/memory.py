"""Companion memory integration over MCP (CI-Server / Hermes memory).

Two directions:

* **Read** — list a user's photos/videos in Companion memory and download one so it can be
  turned into a splat ("explore your own memories in 3D").
* **Write** — record each created 3D asset back into memory so the digital twin remembers it.

The exact CI-memory MCP tool names vary by deployment, so they are configurable and every call
is best-effort: if memory is unset or unreachable, reads return empty and writes are skipped —
a job never fails because of memory.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Optional

import httpx

from .config import Settings
from .models import Asset, MemoryMedia

log = logging.getLogger("ptm.memory")


class MemoryClient:
    def __init__(self, settings: Settings):
        self.settings = settings

    @property
    def enabled(self) -> bool:
        return self.settings.memory_enabled

    async def _call_tool(self, tool: str, args: dict[str, Any]) -> Optional[Any]:
        """Call a tool on the Companion memory MCP server. Returns parsed content or None."""
        if not self.enabled:
            return None
        try:
            from mcp import ClientSession
            from mcp.client.streamable_http import streamablehttp_client
        except Exception:  # noqa: BLE001
            log.warning("mcp client not installed; skipping memory call %s", tool)
            return None
        try:
            async with streamablehttp_client(self.settings.ci_memory_mcp_url) as (r, w, _):
                async with ClientSession(r, w) as session:
                    await session.initialize()
                    result = await session.call_tool(tool, arguments=args)
            return _extract_content(result)
        except Exception as e:  # noqa: BLE001
            log.warning("memory tool %s failed: %s", tool, e)
            return None

    # ── Read ────────────────────────────────────────────────────────────────
    async def list_media(self, owner: str, media_type: str = "image", limit: int = 50) -> list[MemoryMedia]:
        data = await self._call_tool(
            "search_memory",
            {"owner": owner, "type": media_type, "limit": limit},
        )
        items: list[MemoryMedia] = []
        for entry in _as_list(data):
            try:
                items.append(
                    MemoryMedia(
                        ref=str(entry.get("ref") or entry.get("id") or entry.get("url")),
                        kind="video" if media_type == "video" else "image",
                        title=entry.get("title"),
                        thumbnail_url=entry.get("thumbnail_url") or entry.get("url"),
                    )
                )
            except Exception:  # noqa: BLE001
                continue
        return items

    async def download_media(self, ref: str, dest_dir: Path) -> Path:
        """Resolve a memory ref to a local file. Supports URL refs directly; otherwise asks the
        memory server to resolve a URL via a tool."""
        dest_dir.mkdir(parents=True, exist_ok=True)
        url = ref
        if not ref.lower().startswith(("http://", "https://")):
            resolved = await self._call_tool("get_media_url", {"ref": ref})
            url = _first_url(resolved)
            if not url:
                raise ValueError(f"Could not resolve memory ref '{ref}' to a media URL.")
        name = url.split("?")[0].split("/")[-1] or "memory_media"
        dest = dest_dir / name
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            dest.write_bytes(resp.content)
        return dest

    # ── Write ─────────────────────────────────────────────────────────────────
    async def record_asset(self, asset: Asset) -> Optional[str]:
        source = asset.source_origin
        summary = (
            f"Created a 3D {asset.kind} with the {asset.engine} engine from "
            f"{asset.source_type} ({source}). View it at {asset.share_url}."
        )
        payload = {
            "owner": asset.owner,
            "type": "3d_asset",
            "text": summary,
            "metadata": {
                "asset_id": asset.asset_id,
                "kind": asset.kind,
                "engine": asset.engine,
                "share_url": asset.share_url,
                "formats": list(asset.formats.keys()),
                "source_memory_refs": asset.source_memory_refs,
            },
            "tags": asset.tags,
        }
        result = await self._call_tool(self.settings.ci_memory_write_tool, payload)
        if isinstance(result, dict):
            return result.get("id") or result.get("memory_id")
        return None


def _extract_content(result: Any) -> Optional[Any]:
    """Pull JSON/text out of an MCP call_tool result."""
    content = getattr(result, "content", None)
    if not content:
        return getattr(result, "structuredContent", None)
    for block in content:
        text = getattr(block, "text", None)
        if text:
            try:
                return json.loads(text)
            except Exception:  # noqa: BLE001
                return text
    return None


def _as_list(data: Any) -> list[dict]:
    if isinstance(data, list):
        return [d for d in data if isinstance(d, dict)]
    if isinstance(data, dict):
        for key in ("results", "items", "memories", "media"):
            if isinstance(data.get(key), list):
                return [d for d in data[key] if isinstance(d, dict)]
    return []


def _first_url(data: Any) -> Optional[str]:
    if isinstance(data, str) and data.startswith(("http://", "https://")):
        return data
    if isinstance(data, dict):
        return data.get("url") or data.get("media_url")
    return None
