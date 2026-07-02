"""Runtime configuration, loaded from environment (see .env.example)."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Server settings. Every field maps to an environment variable of the same name."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    # Sharing / URLs
    public_base_url: str = "http://localhost:3000"

    # Auth (Companion OIDC)
    auth_disabled: bool = True
    companion_oidc_issuer: str = ""
    companion_oidc_audience: str = ""

    # Companion memory (CI-Server / Hermes memory MCP). Empty = memory writes disabled.
    ci_memory_mcp_url: str = ""
    ci_memory_write_tool: str = "create_memory"

    # Engines
    default_engine: str = "triposplat"
    sharp_enable_research: bool = False
    model_weights_dir: Path = Path("/models")

    # Storage
    asset_dir: Path = Path("./data/assets")

    @property
    def auth_enabled(self) -> bool:
        return not self.auth_disabled

    @property
    def memory_enabled(self) -> bool:
        return bool(self.ci_memory_mcp_url)

    def share_url(self, asset_id: str) -> str:
        return f"{self.public_base_url.rstrip('/')}/view/{asset_id}"


@lru_cache
def get_settings() -> Settings:
    return Settings()
