"""CORS: a wildcard only when a bearer token gates the request.

With auth off there is no token, so the Origin is the only thing between the API and any web
page the owner visits. These pin the policy in `Settings.cors_policy` and, through a real
preflight, that `create_app()` actually applies it.
"""

import pytest
from app.config import HOSTED_VIEWER_ORIGIN, Settings, get_settings
from app.main import create_app
from fastapi.testclient import TestClient


def _preflight(client: TestClient, origin: str):
    """An OPTIONS preflight as a browser at `origin` would send it."""
    return client.options(
        "/healthz",
        headers={"Origin": origin, "Access-Control-Request-Method": "GET"},
    )


def _app(monkeypatch: pytest.MonkeyPatch, **env: str) -> TestClient:
    """A fresh app built under the given environment."""
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    get_settings.cache_clear()
    return TestClient(create_app())


@pytest.fixture(autouse=True)
def _fresh_settings():
    """`get_settings` is cached; never let one test's environment leak into the next."""
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_auth_on_allows_any_origin():
    """With auth on, the bearer token is the gate, so any origin is allowed."""
    policy = Settings(auth_disabled=False).cors_policy
    assert policy == {"allow_origins": ["*"]}


def test_auth_off_allows_the_hosted_viewer_and_the_public_base_url_only_by_name():
    """With auth off the wildcard narrows to named origins."""
    policy = Settings(
        auth_disabled=True, public_base_url="https://viewer.example.org/some/path"
    ).cors_policy
    assert policy["allow_origins"] == [HOSTED_VIEWER_ORIGIN, "https://viewer.example.org"]
    assert "*" not in policy["allow_origins"]


def test_auth_off_adds_the_operators_extra_origins_without_duplicates():
    """ALLOWED_ORIGINS adds to the list, trailing slashes and duplicates removed."""
    policy = Settings(
        auth_disabled=True,
        public_base_url="http://localhost:3000",
        allowed_origins=" http://192.168.1.20:3000/ , https://photo.ci.computer ,",
    ).cors_policy
    assert policy["allow_origins"] == [
        HOSTED_VIEWER_ORIGIN,
        "http://localhost:3000",
        "http://192.168.1.20:3000",
    ]


def test_a_malformed_public_base_url_does_not_break_the_policy():
    """A PUBLIC_BASE_URL that is not a URL is skipped rather than raising."""
    policy = Settings(auth_disabled=True, public_base_url="not a url").cors_policy
    assert policy["allow_origins"] == [HOSTED_VIEWER_ORIGIN]


def test_auth_off_preflight_answers_the_allowed_origins_and_refuses_the_rest(monkeypatch):
    """Through create_app(): allowed origins get CORS headers, lookalikes do not."""
    client = _app(
        monkeypatch, AUTH_DISABLED="1", PUBLIC_BASE_URL="http://localhost:3000", ALLOWED_ORIGINS=""
    )
    for origin in (
        HOSTED_VIEWER_ORIGIN,
        "http://localhost:3000",
        "http://localhost:5173",
        "http://127.0.0.1:8080",
        "http://[::1]:3000",
    ):
        r = _preflight(client, origin)
        assert r.status_code == 200, origin
        assert r.headers.get("access-control-allow-origin") == origin, origin
    for origin in (
        "https://evil.example",
        "http://localhost.evil.example",
        "http://192.168.1.20:3000",
        "https://photo.ci.computer.evil.example",
    ):
        r = _preflight(client, origin)
        assert r.status_code == 400, origin
        assert "access-control-allow-origin" not in r.headers, origin


def test_auth_on_preflight_answers_any_origin(monkeypatch):
    """Through create_app(): with auth on, a preflight from anywhere is answered."""
    client = _app(monkeypatch, AUTH_DISABLED="0")
    r = _preflight(client, "https://anywhere.example")
    assert r.status_code == 200
    assert r.headers.get("access-control-allow-origin") == "*"
