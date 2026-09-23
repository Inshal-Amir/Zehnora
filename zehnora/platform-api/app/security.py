"""Password hashing, opaque tokens and keyed fingerprints."""

from __future__ import annotations

import hashlib
import hmac
import secrets

from pwdlib import PasswordHash

from .config import get_settings

_hasher = PasswordHash.recommended()  # Argon2id


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _hasher.verify(password, password_hash)
    except Exception:
        return False


# Hash of a throwaway password: used to keep login timing similar for unknown emails.
DUMMY_HASH = _hasher.hash("zehnora-dummy-password-for-timing")


def new_token() -> str:
    return secrets.token_urlsafe(32)


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def key_fingerprint(api_key: str) -> str:
    """Keyed lookup fingerprint for a customer API key (never reversible)."""
    secret = get_settings().key_hmac_secret.encode()
    return hmac.new(secret, api_key.encode(), hashlib.sha256).hexdigest()


def csrf_for_session(session_token: str) -> str:
    """CSRF token bound to the session (double-submit: cookie + header must match this)."""
    secret = get_settings().session_secret.encode()
    return hmac.new(secret, b"csrf:" + session_token.encode(), hashlib.sha256).hexdigest()


def constant_eq(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())
