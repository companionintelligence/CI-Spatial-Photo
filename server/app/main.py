"""FastAPI application: REST API + mounted MCP server, sharing one core."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .jobs import JobManager
from .mcp_server import build_mcp
from .routes import router
from .storage import Store

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("ptm")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Core (Store + JobManager) is created once in create_app(); just report readiness here.
    settings = get_settings()
    log.info(
        "CI Photo Time Machine server ready (auth=%s, memory=%s, default_engine=%s)",
        "on" if settings.auth_enabled else "off",
        "on" if settings.memory_enabled else "off",
        settings.default_engine,
    )
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="CI Photo Time Machine",
        version="2.0.0",
        description="Turn any image, image set, or video into a shareable 3D asset.",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/healthz")
    def healthz():
        return {"status": "ok", "version": "2.0.0"}

    app.include_router(router)

    # Mount the MCP server if the optional dependency is present. Build with a temporary core;
    # tools read live state through the JobManager/Store captured here after startup.
    store = Store(settings.asset_dir)
    jobs = JobManager(store, settings)
    app.state.store = store
    app.state.jobs = jobs
    mcp = build_mcp(jobs, store, settings)
    if mcp is not None:
        app.mount("/mcp", mcp.streamable_http_app())
        log.info("MCP server mounted at /mcp")
    else:
        log.warning("mcp package not installed; /mcp disabled (REST still available)")

    return app


app = create_app()
