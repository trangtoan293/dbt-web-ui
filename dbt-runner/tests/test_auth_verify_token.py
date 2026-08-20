from unittest.mock import AsyncMock

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException
from jwt.algorithms import RSAAlgorithm

from app.config import settings
from app.core import auth


@pytest.fixture
def signing_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture
def jwk(signing_key):
    key = RSAAlgorithm.to_jwk(signing_key.public_key(), as_dict=True)
    key["kid"] = "trusted-key"
    key["alg"] = "RS256"
    return key


def _token(signing_key, *, kid="trusted-key", **claims):
    payload = {
        "sub": "user-1",
        "email": "user@example.com",
        "iss": "https://identity.example.com/realms/test",
        "aud": "dbt-craft",
        "exp": 4_102_444_800,
        **claims,
    }
    return jwt.encode(payload, signing_key, algorithm="RS256", headers={"kid": kid})


@pytest.mark.asyncio
async def test_verify_token_accepts_matching_key_and_claims(monkeypatch, signing_key, jwk):
    monkeypatch.setattr(settings, "oidc_issuer", "https://identity.example.com/realms/test")
    monkeypatch.setattr(settings, "oidc_audience", "dbt-craft")
    monkeypatch.setattr(auth, "_fetch_jwks", AsyncMock(return_value=[jwk]))

    claims = await auth.verify_token(_token(signing_key))

    assert claims["sub"] == "user-1"
    assert claims["email"] == "user@example.com"


@pytest.mark.asyncio
async def test_verify_token_rejects_unknown_key_id(monkeypatch, signing_key, jwk):
    monkeypatch.setattr(settings, "oidc_issuer", "https://identity.example.com/realms/test")
    monkeypatch.setattr(settings, "oidc_audience", "dbt-craft")
    monkeypatch.setattr(auth, "_fetch_jwks", AsyncMock(return_value=[jwk]))

    with pytest.raises(HTTPException) as exc:
        await auth.verify_token(_token(signing_key, kid="unknown-key"))

    assert exc.value.status_code == 401
    assert exc.value.detail == "Unknown token signing key"


@pytest.mark.asyncio
async def test_verify_token_rejects_expired_token(monkeypatch, signing_key, jwk):
    monkeypatch.setattr(settings, "oidc_issuer", "https://identity.example.com/realms/test")
    monkeypatch.setattr(settings, "oidc_audience", "dbt-craft")
    monkeypatch.setattr(auth, "_fetch_jwks", AsyncMock(return_value=[jwk]))

    with pytest.raises(HTTPException) as exc:
        await auth.verify_token(_token(signing_key, exp=1))

    assert exc.value.status_code == 401
    assert exc.value.detail == "Invalid token"
