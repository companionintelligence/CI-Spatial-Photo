"""Companion OIDC authentication.

Verifies a bearer token against a configured OIDC issuer's JWKS (standard OpenID Connect, so
it works with whatever provider the Companion server runs). A dev bypass (``AUTH_DISABLED=1``)
returns a local principal so hacking on the app locally needs no identity provider.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Optional

import httpx
from fastapi import Depends, Header, HTTPException, status
from pydantic import BaseModel

from .config import Settings, get_settings

# NOTE: PyJWT / cryptography are imported lazily inside the verification helpers so that the
# app (and its tests) run in environments where those native deps aren't present, as long as
# auth is disabled. When AUTH_DISABLED=0 the container image must provide pyjwt + cryptography.


class Principal(BaseModel):
    subject: str
    email: Optional[str] = None

    @property
    def owner_key(self) -> str:
        return self.email or self.subject


@lru_cache
def _jwk_client(issuer: str):
    import jwt

    disc = httpx.get(
        f"{issuer.rstrip('/')}/.well-known/openid-configuration", timeout=10
    ).json()
    return jwt.PyJWKClient(disc["jwks_uri"])


def _verify(token: str, settings: Settings) -> Principal:
    import jwt

    try:
        signing_key = _jwk_client(settings.companion_oidc_issuer).get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256", "ES256"],
            audience=settings.companion_oidc_audience or None,
            issuer=settings.companion_oidc_issuer or None,
            options={"verify_aud": bool(settings.companion_oidc_audience)},
        )
    except Exception as e:  # noqa: BLE001 — any verification failure is a 401
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=f"Invalid token: {e}"
        ) from e
    return Principal(subject=str(claims.get("sub", "unknown")), email=claims.get("email"))


def require_principal(
    authorization: Optional[str] = Header(default=None),
    settings: Settings = Depends(get_settings),
) -> Principal:
    if settings.auth_disabled:
        return Principal(subject="local-dev", email="dev@local")
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token"
        )
    return _verify(authorization.split(" ", 1)[1].strip(), settings)
