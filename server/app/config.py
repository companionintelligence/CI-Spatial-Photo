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

    # Depth engines (depth-image / depth-video). See server/app/engines/depth_models.py.
    depth_model: str = "depth-anything-v2-small"
    depth_video_model: str = "depth-anything-v2-small"
    # Depth Anything V2 Base/Large, Video Depth Anything Large and Depth Pro all ship
    # non-commercial weights. Same posture as SHARP: off unless the operator opts in.
    depth_allow_noncommercial: bool = False
    # Assumed horizontal field of view when the model cannot tell us the real one. 60 deg is
    # close to a phone's main camera; only Depth Pro predicts the true focal length.
    depth_fov_deg: float = 60.0
    # Far/near depth ratio the relative (inverse-depth) models are mapped onto. Higher = more
    # dramatic parallax and more visible stretching at occlusion boundaries.
    depth_range: float = 8.0
    depth_max_points: int = 400_000
    # Percentage of pixels with the steepest depth gradient to discard. Without this, every
    # foreground/background boundary becomes a sheet of Gaussians smeared between the two,
    # which is the single most recognisable artefact of naive monocular-depth splatting.
    depth_edge_drop_percent: float = 2.0
    depth_video_fps: float = 2.0
    depth_video_max_frames: int = 32
    # Let the depth engines participate in *automatic* routing (ahead of the flat Preview
    # fallback). Off by default so installing the optional torch extra cannot silently change
    # which engine every existing upload goes to; `DEFAULT_ENGINE=depth-image` and an explicit
    # per-job `engine=` both work regardless of this flag.
    depth_auto_route: bool = False

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
