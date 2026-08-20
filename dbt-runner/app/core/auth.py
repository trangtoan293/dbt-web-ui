"""
OIDC JWT authentication for FastAPI.

Validates Bearer tokens against the configured OIDC issuer. Signing keys come
from the issuer's `jwks_uri`, discovered through
`{issuer}/.well-known/openid-configuration`, so any spec-compliant provider
works without provider-specific URL templates.
"""

import logging
from typing import Optional

import httpx
import jwt
from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jwt import PyJWK, PyJWTError
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings

logger = logging.getLogger(__name__)

security = HTTPBearer(auto_error=False)

# Fixed identity used when AUTH_DISABLED. Must match the frontend's no-auth
# default (nextjs/src/lib/auth-constants.ts) so ownership scoping lines up.
LOCAL_USER_SUB = "local-user"
LOCAL_USER_EMAIL = "local@dbt-craft.local"


def _local_claims(request: Request) -> dict:
    request.state.user_id = LOCAL_USER_SUB
    request.state.user_email = LOCAL_USER_EMAIL
    return {"sub": LOCAL_USER_SUB, "email": LOCAL_USER_EMAIL}

# Cached discovery document and JWKS, each keyed by the URL it came from so a
# changed issuer invalidates the cache instead of serving stale keys.
_jwks_cache: Optional[list] = None
_jwks_cache_uri: Optional[str] = None
_discovered_jwks_uri: Optional[str] = None
_discovery_issuer: Optional[str] = None


async def _resolve_jwks_uri() -> str:
    """Return the issuer's jwks_uri, via OIDC discovery unless configured."""
    global _discovered_jwks_uri, _discovery_issuer

    if settings.oidc_jwks_uri:
        return settings.oidc_jwks_uri

    issuer = settings.oidc_issuer
    if not issuer:
        raise HTTPException(status_code=500, detail="OIDC issuer is not configured")

    if _discovered_jwks_uri is not None and _discovery_issuer == issuer:
        return _discovered_jwks_uri

    url = f"{issuer.rstrip('/')}/.well-known/openid-configuration"
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        document: dict = resp.json()  # type: ignore[assignment]

    jwks_uri = document.get("jwks_uri")
    if not jwks_uri:
        raise HTTPException(
            status_code=500, detail="OIDC discovery document has no jwks_uri"
        )

    _discovered_jwks_uri = jwks_uri
    _discovery_issuer = issuer
    logger.info("Discovered jwks_uri %s from %s", jwks_uri, url)
    return jwks_uri


async def _fetch_jwks() -> list:
    """Fetch and cache the issuer's signing keys."""
    global _jwks_cache, _jwks_cache_uri
    uri = await _resolve_jwks_uri()

    if _jwks_cache is not None and _jwks_cache_uri == uri:
        return _jwks_cache

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(uri)
        resp.raise_for_status()
        data: dict = resp.json()  # type: ignore[assignment]
        _jwks_cache = data.get("keys", []) or []
        _jwks_cache_uri = uri
        logger.info("Fetched %d JWKS keys from %s", len(_jwks_cache), uri)
        return _jwks_cache  # type: ignore[return-value]


async def verify_token(token: str) -> dict:
    """Verify an OIDC JWT and return its claims."""
    jwks = await _fetch_jwks()
    try:
        unverified = jwt.get_unverified_header(token)
    except PyJWTError as exc:
        raise HTTPException(status_code=401, detail="Invalid token format") from exc
    if unverified.get("alg") != "RS256":
        raise HTTPException(status_code=401, detail="Unsupported token algorithm")
    kid = unverified.get("kid")

    key_data = next((key for key in jwks if key.get("kid") == kid), None)
    if key_data is None:
        raise HTTPException(status_code=401, detail="Unknown token signing key")

    try:
        public_key = PyJWK.from_dict(key_data, algorithm="RS256").key
        claims = jwt.decode(
            token,
            public_key,
            algorithms=["RS256"],
            audience=settings.oidc_audience or "dbt-craft",
            issuer=settings.oidc_issuer,
            options={"require": ["exp", "sub"]},
        )
        return claims
    except (PyJWTError, ValueError) as exc:
        logger.warning("JWT verification failed: %s", exc)
        raise HTTPException(status_code=401, detail="Invalid token") from exc


def extract_bearer_token(request: Request) -> str | None:
    """Return the raw bearer token string from the Authorization header, or None."""
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip() or None
    return None


async def require_user(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> dict:
    """FastAPI dependency: require a valid OIDC JWT, return claims."""
    if settings.auth_disabled:
        return _local_claims(request)

    if not credentials:
        raise HTTPException(status_code=401, detail="Missing Authorization header")

    token = credentials.credentials
    claims = await verify_token(token)

    # Store user_id on request state for convenience
    request.state.user_id = claims.get("sub")
    request.state.user_email = claims.get("email")

    return claims


async def get_optional_user(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> Optional[dict]:
    """FastAPI dependency: optionally extract user from JWT."""
    if settings.auth_disabled:
        return _local_claims(request)

    if not credentials:
        return None
    try:
        claims = await verify_token(credentials.credentials)
        request.state.user_id = claims.get("sub")
        request.state.user_email = claims.get("email")
        return claims
    except HTTPException:
        return None


async def resolve_user_id(
    session: AsyncSession, oidc_sub: str, email: Optional[str] = None
) -> str:
    """
    Resolve an OIDC `sub` claim to the application user ID, with email fallback.

    A provider's `sub` can change (for example when a realm is reset), so:
    1. Look up the user by oidc_sub
    2. Fall back to email when the sub does not match
    3. Update oidc_sub silently when found by email
    4. Raise 404 when there is no such user
    """
    result = await session.execute(
        text("SELECT id, oidc_sub FROM users WHERE oidc_sub = :sub"),
        {"sub": oidc_sub},
    )
    row = result.mappings().first()
    if row:
        return str(row["id"])

    if email:
        result = await session.execute(
            text("SELECT id, oidc_sub FROM users WHERE email = :email"),
            {"email": email},
        )
        row = result.mappings().first()
        if row:
            await session.execute(
                text("UPDATE users SET oidc_sub = :sub WHERE id = :uid"),
                {"sub": oidc_sub, "uid": row["id"]},
            )
            await session.commit()
            logger.info(
                "Updated oidc_sub for user %s: %s -> %s",
                row["id"],
                row["oidc_sub"],
                oidc_sub,
            )
            return str(row["id"])

    raise HTTPException(status_code=404, detail="User not found")
