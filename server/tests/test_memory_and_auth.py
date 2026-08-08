"""Companion-memory response parsing, and the authentication boundary.

These two are grouped because they share a property: both parse input this server does not
control, and both fail *open* in ways that are hard to see. The memory client's own docstring
says the tool names and response shapes "vary by deployment", so the parsers are tolerant by
design — and tolerant parsing is exactly the kind that quietly returns nothing when the shape
changes. Auth is the other direction: a bypass is silent until someone goes looking.

No network anywhere. `_call_tool` short-circuits when `CI_MEMORY_MCP_URL` is empty, and the two
tests that need a response substitute one.
"""

from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import auth as auth_module
from app.auth import Principal, require_principal
from app.config import Settings, get_settings
from app.main import app
from app.memory import MemoryClient, _as_list, _extract_content, _first_url
from app.models import Asset


def _settings(**kw) -> Settings:
    base = dict(auth_disabled=True, ci_memory_mcp_url="")
    base.update(kw)
    return Settings(**base)


def _block(text: str):
    return SimpleNamespace(text=text)


# ── MCP result unwrapping ─────────────────────────────────────────────────────────────────

def test_json_inside_a_text_block_is_parsed():
    """MCP tools return content blocks; the payload is JSON in a string inside one of them."""
    result = SimpleNamespace(content=[_block('{"results": [{"id": "m1"}]}')])
    assert _extract_content(result) == {"results": [{"id": "m1"}]}


def test_a_text_block_that_is_not_json_comes_back_as_text():
    """A tool that returns a bare URL string is a legitimate shape, not a parse failure."""
    result = SimpleNamespace(content=[_block("https://example.com/a.jpg")])
    assert _extract_content(result) == "https://example.com/a.jpg"


def test_structured_content_is_used_when_there_are_no_text_blocks():
    """Newer MCP servers answer with structuredContent and an empty content list."""
    result = SimpleNamespace(content=[], structuredContent={"url": "https://x/y.png"})
    assert _extract_content(result) == {"url": "https://x/y.png"}


def test_blocks_with_no_text_at_all_yield_nothing_rather_than_raising():
    result = SimpleNamespace(content=[SimpleNamespace(other="x")], structuredContent=None)
    assert _extract_content(result) is None


@pytest.mark.parametrize("key", ["results", "items", "memories", "media"])
def test_a_media_list_is_found_under_any_of_the_known_envelope_keys(key):
    """Four spellings because four deployments spell it differently; all four must work."""
    assert _as_list({key: [{"id": "m1"}]}) == [{"id": "m1"}]


def test_non_dict_entries_are_dropped_instead_of_crashing_the_listing():
    """One malformed row in a response must not empty the user's whole gallery."""
    assert _as_list([{"id": "m1"}, "junk", None, {"id": "m2"}]) == [{"id": "m1"}, {"id": "m2"}]


@pytest.mark.parametrize("data", [None, "a string", 42, {"unexpected": [{"id": "m"}]}, {}])
def test_an_unrecognised_envelope_yields_an_empty_list(data):
    assert _as_list(data) == []


@pytest.mark.parametrize(
    "data, expected",
    [
        ("https://example.com/a.jpg", "https://example.com/a.jpg"),
        ("http://example.com/a.jpg", "http://example.com/a.jpg"),
        ({"url": "https://example.com/a.jpg"}, "https://example.com/a.jpg"),
        ({"media_url": "https://example.com/b.jpg"}, "https://example.com/b.jpg"),
        ("/local/path.jpg", None),        # a bare path is not something to fetch
        ("ftp://example.com/a.jpg", None),
        ({"nothing": 1}, None),
        (None, None),
        (["https://example.com/a.jpg"], None),
    ],
)
def test_url_extraction_accepts_only_http_urls(data, expected):
    """`download_media` hands this straight to httpx, so anything that is not an http(s) URL
    has to be rejected here rather than becoming a confusing request error."""
    assert _first_url(data) == expected


# ── listing media ─────────────────────────────────────────────────────────────────────────

async def test_listing_media_is_empty_and_silent_when_memory_is_not_configured():
    """The default deployment has no memory server, and the client calls this on page load."""
    assert await MemoryClient(_settings()).list_media("dev@local") == []


async def test_each_entry_falls_back_through_ref_then_id_then_url(monkeypatch):
    """Three deployments, three names for the same field."""
    client = MemoryClient(_settings(ci_memory_mcp_url="http://memory.invalid"))

    async def fake_call(tool, args):
        return [
            {"ref": "by-ref", "id": "ignored"},
            {"id": "by-id", "title": "A photo"},
            {"url": "https://example.com/by-url.jpg", "thumbnail_url": "https://example.com/t.jpg"},
        ]

    client._call_tool = fake_call
    media = await client.list_media("dev@local", media_type="image")
    assert [m.ref for m in media] == ["by-ref", "by-id", "https://example.com/by-url.jpg"]
    assert media[1].title == "A photo"
    # thumbnail_url falls back to the media url itself so the gallery is never blank.
    assert media[2].thumbnail_url == "https://example.com/t.jpg"
    assert all(m.kind == "image" for m in media)


async def test_the_media_type_decides_the_kind_and_is_passed_to_the_tool():
    """`kind` drives which engine the client will offer for the item."""
    client = MemoryClient(_settings(ci_memory_mcp_url="http://memory.invalid"))
    seen: dict = {}

    async def fake_call(tool, args):
        seen.update(args)
        seen["tool"] = tool
        return [{"id": "m1"}]

    client._call_tool = fake_call
    media = await client.list_media("dev@local", media_type="video", limit=7)
    assert media[0].kind == "video"
    assert seen["tool"] == "search_memory"
    assert seen["owner"] == "dev@local" and seen["type"] == "video" and seen["limit"] == 7


# ── downloading ───────────────────────────────────────────────────────────────────────────

async def test_an_unresolvable_ref_raises_before_any_http_call(tmp_path: Path):
    """With memory disabled there is nothing to resolve a non-URL ref against.

    The error has to name the ref: a memory job carries several, and "download failed" without
    one is unusable in a log.
    """
    client = MemoryClient(_settings())
    with pytest.raises(ValueError, match="mem_abc"):
        await client.download_media("mem_abc", tmp_path / "in")


# ── recording an asset back to memory ─────────────────────────────────────────────────────

async def test_the_recorded_memory_carries_the_share_url_and_provenance():
    """This text is what the user's Companion will later surface; it has to be self-contained.

    Without the share URL in the summary the memory says a 3D asset exists and gives no way to
    open it, which is the entire point of writing it back.
    """
    client = MemoryClient(_settings(ci_memory_mcp_url="http://memory.invalid"))
    captured: dict = {}

    async def fake_call(tool, args):
        captured["tool"] = tool
        captured["args"] = args
        return {"id": "mem_written"}

    client._call_tool = fake_call
    asset = Asset(
        asset_id="a_1", owner="dev@local", kind="splat", engine="depth-image",
        source_type="image", source_origin="upload", tags=["3d", "splat"],
        formats={"ply": "master.ply", "spz": "model.spz"},
        share_url="http://localhost:3000/view/a_1", source_memory_refs=["mem_src"],
    )
    assert await client.record_asset(asset) == "mem_written"

    assert captured["tool"] == "create_memory"  # the configurable default
    args = captured["args"]
    assert "http://localhost:3000/view/a_1" in args["text"]
    assert "depth-image" in args["text"]
    assert args["metadata"]["asset_id"] == "a_1"
    assert sorted(args["metadata"]["formats"]) == ["ply", "spz"]
    assert args["metadata"]["source_memory_refs"] == ["mem_src"]
    assert args["owner"] == "dev@local" and args["type"] == "3d_asset"


async def test_a_write_tool_that_returns_nothing_useful_yields_no_memory_id():
    """Best-effort in both directions: a tool answering with a bare string is not an error."""
    client = MemoryClient(_settings(ci_memory_mcp_url="http://memory.invalid"))

    async def fake_call(tool, args):
        return "ok"

    client._call_tool = fake_call
    asset = Asset(asset_id="a_1", owner="u", kind="splat", engine="preview",
                  source_type="image", source_origin="upload")
    assert await client.record_asset(asset) is None


async def test_the_write_tool_name_is_configurable():
    """CI_MEMORY_WRITE_TOOL exists because the tool is named differently per deployment."""
    client = MemoryClient(
        _settings(ci_memory_mcp_url="http://memory.invalid", ci_memory_write_tool="remember_this")
    )
    seen: list[str] = []

    async def fake_call(tool, args):
        seen.append(tool)
        return None

    client._call_tool = fake_call
    await client.record_asset(Asset(asset_id="a", owner="u", kind="splat", engine="preview",
                                    source_type="image", source_origin="upload"))
    assert seen == ["remember_this"]


async def test_no_tool_is_called_at_all_when_memory_is_disabled():
    """The guard is inside `_call_tool`, so every caller inherits it — including future ones."""
    client = MemoryClient(_settings(ci_memory_mcp_url=""))
    assert client.enabled is False
    assert await client._call_tool("anything", {}) is None


# ── authentication ────────────────────────────────────────────────────────────────────────

def test_the_owner_key_prefers_email_and_falls_back_to_subject():
    """`owner_key` partitions every asset and job, so which field wins is a data-model decision.

    An OIDC provider that stops sending `email` would silently re-key every user to their
    subject and hide their entire library.
    """
    assert Principal(subject="sub-1", email="a@b.c").owner_key == "a@b.c"
    assert Principal(subject="sub-1").owner_key == "sub-1"


def test_the_dev_bypass_is_only_reachable_with_auth_explicitly_disabled():
    principal = require_principal(authorization=None, settings=_settings(auth_disabled=True))
    assert principal.owner_key == "dev@local"


@pytest.fixture()
def auth_on():
    """Turn authentication on for the mounted app without touching the cached settings."""
    app.dependency_overrides[get_settings] = lambda: Settings(
        auth_disabled=False, companion_oidc_issuer="https://issuer.invalid",
        companion_oidc_audience="ptm", ci_memory_mcp_url="",
    )
    yield TestClient(app)
    app.dependency_overrides.pop(get_settings, None)


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": ""},
        {"Authorization": "token abc"},
        {"Authorization": "Basic dXNlcjpwYXNz"},
        {"Authorization": "Bearer"},          # scheme with no space or token
    ],
)
def test_a_request_without_a_bearer_token_is_rejected(auth_on, headers):
    """Every one of these is a real client bug that must not read as an anonymous session."""
    response = auth_on.get("/api/v1/assets", headers=headers)
    assert response.status_code == 401
    assert "bearer" in response.json()["detail"].lower()


def test_an_unverifiable_token_is_a_401_and_not_a_500(auth_on, monkeypatch):
    """Every verification failure — bad signature, wrong audience, expired, unreachable JWKS —
    has to land on 401. A 500 here is an availability bug that looks like an outage."""
    def broken_jwk_client(issuer):
        raise RuntimeError("JWKS endpoint unreachable")

    monkeypatch.setattr(auth_module, "_jwk_client", broken_jwk_client)
    response = auth_on.get("/api/v1/assets", headers={"Authorization": "Bearer not.a.jwt"})
    assert response.status_code == 401
    assert "Invalid token" in response.json()["detail"]


def test_the_case_of_the_bearer_scheme_does_not_matter(auth_on, monkeypatch):
    """`bearer` lowercase is valid per RFC 6750 and some clients send it that way."""
    monkeypatch.setattr(
        auth_module, "_jwk_client",
        lambda issuer: (_ for _ in ()).throw(RuntimeError("stop here")),
    )
    response = auth_on.get("/api/v1/assets", headers={"Authorization": "bearer abc"})
    # It got past the scheme check and into verification, which is all this asserts.
    assert response.status_code == 401
    assert "Invalid token" in response.json()["detail"]


def test_healthz_stays_open_when_auth_is_on(auth_on):
    """Probes have no token, and a health check behind auth reports a healthy server as down."""
    assert auth_on.get("/healthz").status_code == 200
    assert auth_on.head("/healthz").status_code == 200
