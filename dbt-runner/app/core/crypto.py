"""
Small encryption helper for application-managed secrets.

APP_ENCRYPTION_KEY is treated as key material and derived into a Fernet key, so
deployments can use a normal high-entropy string instead of Fernet's exact
base64 format.
"""

import base64
import hashlib
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.fernet import Fernet, InvalidToken

from app.config import settings


class EncryptionError(ValueError):
    """Raised when encryption/decryption cannot be performed."""


AES_GCM_PREFIX = "v1:gcm:"


def _key_bytes() -> bytes:
    key_material = settings.app_encryption_key
    if not key_material:
        raise EncryptionError("APP_ENCRYPTION_KEY is required for encrypted secrets")
    return hashlib.sha256(key_material.encode("utf-8")).digest()


def _fernet() -> Fernet:
    key = base64.urlsafe_b64encode(_key_bytes())
    return Fernet(key)


def encrypt_secret(secret: str) -> str:
    if secret == "":
        raise EncryptionError("Cannot encrypt an empty secret")
    return _fernet().encrypt(secret.encode("utf-8")).decode("utf-8")


def encrypt_secret_v1(secret: str) -> str:
    if secret == "":
        raise EncryptionError("Cannot encrypt an empty secret")
    nonce = os.urandom(12)
    encrypted = AESGCM(_key_bytes()).encrypt(nonce, secret.encode("utf-8"), None)
    return (
        f"{AES_GCM_PREFIX}"
        f"{base64.b64encode(nonce).decode('utf-8')}:"
        f"{base64.b64encode(encrypted).decode('utf-8')}"
    )


def decrypt_secret(ciphertext: str) -> str:
    if ciphertext.startswith(AES_GCM_PREFIX):
        try:
            _, _, nonce_b64, payload_b64 = ciphertext.split(":", 3)
            nonce = base64.b64decode(nonce_b64)
            payload = base64.b64decode(payload_b64)
            return AESGCM(_key_bytes()).decrypt(nonce, payload, None).decode("utf-8")
        except Exception as exc:
            raise EncryptionError("Encrypted secret cannot be decrypted") from exc

    try:
        return _fernet().decrypt(ciphertext.encode("utf-8")).decode("utf-8")
    except InvalidToken as exc:
        raise EncryptionError("Encrypted secret cannot be decrypted") from exc


def decrypt_secret_or_plaintext(value: str | None) -> str:
    """Decrypt current secrets; keep legacy plaintext values working."""
    if not value:
        return ""
    if value.startswith(AES_GCM_PREFIX) or value.startswith("gAAAAA"):
        return decrypt_secret(value)
    return value
