"""FastAPI application: REST API + mounted MCP server, sharing one core."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .jobs import JobManager
from .mcp_server import build_mcp, build_mcp_app
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

    # The mounted MCP app is an ASGI app, but it is not self-starting: its
    # StreamableHTTPSessionManager owns an anyio task group that only exists inside
    # `session_manager.run()`. Mounting it without entering that context produced a server
    # that looked healthy and answered every REST call, while *every* request to /mcp died
    # with `RuntimeError: Task group is not initialized` — a 500 on the repo's headline
    # feature, reachable only by actually speaking MCP to it. A mount does not inherit the
    # sub-app's lifespan, so the host has to run it here.
    mcp = getattr(app.state, "mcp", None)
    if mcp is None:
        yield
        return
    async with mcp.session_manager.run():
        log.info("MCP session manager running")
        yield


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="CI Photo Time Machine",
        version="2.0.0",
        description="Turn any image, image set, or video into a shareable 3D asset.",
        lifespan=lifespan,
    )
    # Wildcard only when requests are gated by a bearer token; see Settings.cors_policy.
    app.add_middleware(
        CORSMiddleware,
        allow_methods=["*"],
        allow_headers=["*"],
        **settings.cors_policy,
    )

    # HEAD as well as GET. FastAPI's @app.get registers GET only — unlike
    # Starlette's plain Route, an APIRoute does not imply HEAD — so a HEAD probe
    # got 405 Method Not Allowed from a server that was perfectly healthy. HEAD is
    # the default probe for a lot of monitoring, `wait-on` included, and it cost
    # this repo every product-video run: the stage sat in a 120s wait-on loop
    # answering 405 to every poll and then reported a timeout.
    @app.api_route("/healthz", methods=["GET", "HEAD"])
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
    app.state.mcp = mcp
    if mcp is not None:
        # Mounting is also what constructs the session manager the lifespan runs, so this
        # has to happen here at build time and not lazily on first request.
        app.mount("/mcp", build_mcp_app(mcp, settings))
        log.info("MCP server mounted at /mcp")
    else:
        log.warning("mcp unavailable; /mcp disabled (REST still available)")

    return app


app = create_app()
