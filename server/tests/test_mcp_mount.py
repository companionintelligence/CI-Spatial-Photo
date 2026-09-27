"""The mounted MCP surface, exercised over HTTP rather than by importing it.

Every other test in this suite reaches the app's capabilities through REST or by calling
the engines directly, and `test_pipeline.py` builds the MCP tools in-process. None of them
sends a request to `/mcp`, which is how the app shipped in two states where the repo's
headline feature — "MCP-native, point your agent at /mcp" — was entirely dead:

  1. `mcp` 2.0 renamed FastMCP to MCPServer, so `build_mcp()`'s import failed and its
     `except Exception: return None` turned that into a silent "/mcp disabled" warning in
     the log. Fixed by bounding the extra at `mcp<2` in pyproject.toml.
  2. The sub-app was mounted without its StreamableHTTPSessionManager ever being started,
     so it answered every request with `RuntimeError: Task group is not initialized`.
     Fixed by running `session_manager.run()` in the host app's lifespan.

  3. FastMCP derived a loopback-only Host allowlist and turned DNS-rebinding protection on,
     so behind a reverse proxy (photo.ci.computer -> the GPU origin) every agent request
     came back 421 "Invalid Host header". Fixed by MCP_ALLOWED_HOSTS.

All three are invisible unless something actually speaks MCP over the mount, which is what
this does. Two details are load-bearing: `TestClient` used as a context manager runs the
lifespan (no lifespan, no task group), and each test builds its own app, because a
StreamableHTTPSessionManager refuses to `run()` twice and the module-level `app` is a
singleton.
"""

import pytest
from fastapi.testclient import TestClient

pytest.importorskip("mcp.server.fastmcp", reason="MCP surface needs the [mcp] extra")

from app.config import Settings, get_settings  # noqa: E402
from app.main import create_app  # noqa: E402

MCP_HEADERS = {
    "Content-Type": "application/json",
    # Streamable HTTP negotiates between a JSON reply and an SSE stream; the server rejects
    # a request that will accept only one of them.
    "Accept": "application/json, text/event-stream",
}

INITIALIZE = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "ptm-tests", "version": "1"},
    },
}

@pytest.fixture(autouse=True)
def allow_the_test_clients_host(monkeypatch):
    """`TestClient` sends `Host: testserver`; let the MCP transport accept it.

    Which is itself the point of the setting — a Host that is not loopback is what every
    deployment behind a proxy looks like. The rejection path is asserted explicitly below.
    """
    monkeypatch.setenv("MCP_ALLOWED_HOSTS", "testserver")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


EXPECTED_TOOLS = {
    "list_engines",
    "image_to_3d",
    "media_to_3d",
    "get_job",
    "list_assets",
    "get_asset",
    "get_share_url",
}


def test_mcp_is_mounted_and_running():
    """A handshake against /mcp succeeds and identifies this server."""
    with TestClient(create_app()) as client:
        response = client.post("/mcp/", json=INITIALIZE, headers=MCP_HEADERS)

    assert response.status_code == 200, response.text
    # The session id proves the session manager's task group is live: without the lifespan
    # this request raised instead of allocating one.
    assert response.headers.get("mcp-session-id")
    assert "photo-time-machine" in response.text


def test_mcp_advertises_every_tool_the_manifest_promises():
    """companion-app.json and the README list seven tools; the mount must serve all seven."""
    with TestClient(create_app()) as client:
        handshake = client.post("/mcp/", json=INITIALIZE, headers=MCP_HEADERS)
        assert handshake.status_code == 200, handshake.text
        session = {"mcp-session-id": handshake.headers["mcp-session-id"], **MCP_HEADERS}

        client.post(
            "/mcp/",
            json={"jsonrpc": "2.0", "method": "notifications/initialized"},
            headers=session,
        )
        listing = client.post(
            "/mcp/",
            json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            headers=session,
        )

    assert listing.status_code == 200, listing.text
    missing = {name for name in EXPECTED_TOOLS if f'"name":"{name}"' not in listing.text}
    assert not missing, f"tools/list did not advertise: {sorted(missing)}"


def test_a_proxied_host_is_rejected_until_it_is_allowed(monkeypatch):
    """The 421 that hid behind every reverse proxy, and the setting that clears it.

    `TestClient` sends `Host: testserver`, which stands in for exactly the case that
    matters: a Host that is not loopback because something in front of the server rewrote
    it. Unlisted it must be refused — the DNS-rebinding protection is wanted, not worked
    around — and naming it in MCP_ALLOWED_HOSTS must be all it takes.
    """
    get_settings.cache_clear()
    monkeypatch.setenv("MCP_ALLOWED_HOSTS", "")
    with TestClient(create_app()) as client:
        refused = client.post("/mcp/", json=INITIALIZE, headers=MCP_HEADERS)
    assert refused.status_code == 421, refused.text

    get_settings.cache_clear()
    monkeypatch.setenv("MCP_ALLOWED_HOSTS", "testserver,photo.ci.computer")
    with TestClient(create_app()) as client:
        allowed = client.post("/mcp/", json=INITIALIZE, headers=MCP_HEADERS)
    assert allowed.status_code == 200, allowed.text

    get_settings.cache_clear()


def test_the_allowlist_keeps_loopback_and_accepts_a_bare_hostname():
    """Unit-level: what Settings hands FastMCP."""
    settings = Settings(mcp_allowed_hosts="photo.ci.computer, ptm-origin.ci.computer:8443")
    hosts = settings.mcp_host_allowlist
    assert "127.0.0.1:*" in hosts and "localhost:*" in hosts
    # A bare name gets a port-wildcard twin; one written with a port is taken as given.
    assert "photo.ci.computer" in hosts and "photo.ci.computer:*" in hosts
    assert "ptm-origin.ci.computer:8443" in hosts
    assert "ptm-origin.ci.computer:8443:*" not in hosts
    # Origins default to https:// of each configured host.
    origins = Settings(mcp_allowed_hosts="photo.ci.computer").mcp_origin_allowlist
    assert origins == ["https://photo.ci.computer"]
