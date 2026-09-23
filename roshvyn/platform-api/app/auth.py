"""Portal sessions (cookie + CSRF) and API-key authentication for /v1."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from fastapi import Depends, Request
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import get_settings
from .db import get_db
from .errors import ApiError
from .models import ApiKey, LoginAttempt, Session, User
from .security import constant_eq, csrf_for_session, key_fingerprint, sha256_hex

SESSION_COOKIE = "roshvyn_session"
CSRF_COOKIE = "roshvyn_csrf"
CSRF_HEADER = "x-csrf-token"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def now() -> datetime:
    return datetime.now(timezone.utc)


def client_ip(request: Request) -> str | None:
    return request.client.host if request.client else None


@dataclass
class Principal:
    user: User
    session: Session


async def current_session(request: Request, db: AsyncSession = Depends(get_db)) -> Principal:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise ApiError(401, "not_authenticated", "Login required.")
    row = (
        await db.execute(
            select(Session, User).join(User, User.id == Session.user_id).where(Session.token_hash == sha256_hex(token))
        )
    ).first()
    if not row:
        raise ApiError(401, "not_authenticated", "Session is invalid.")
    session, user = row
    if session.revoked_at is not None or session.expires_at <= now():
        raise ApiError(401, "session_expired", "Session expired. Please log in again.")
    if user.status != "active":
        raise ApiError(403, "account_disabled", "This account is disabled.")
    # CSRF: cookie-authenticated mutations must echo the session-bound token in a header.
    if request.method not in SAFE_METHODS:
        header = request.headers.get(CSRF_HEADER, "")
        cookie = request.cookies.get(CSRF_COOKIE, "")
        expected = csrf_for_session(token)
        if not (header and constant_eq(header, expected) and constant_eq(cookie, expected)):
            raise ApiError(403, "csrf_failed", "Missing or invalid CSRF token.")
    return Principal(user=user, session=session)


async def admin_session(principal: Principal = Depends(current_session)) -> Principal:
    if principal.user.role != "admin":
        raise ApiError(403, "admin_required", "Administrator access required.")
    return principal


async def check_login_throttle(db: AsyncSession, email: str, ip: str | None) -> None:
    s = get_settings()
    since = now() - timedelta(minutes=s.login_window_minutes)
    by_email = await db.scalar(
        select(func.count()).select_from(LoginAttempt).where(
            LoginAttempt.email == email, LoginAttempt.success.is_(False), LoginAttempt.created_at > since)
    )
    by_ip = 0
    if ip:
        by_ip = await db.scalar(
            select(func.count()).select_from(LoginAttempt).where(
                LoginAttempt.ip == ip, LoginAttempt.success.is_(False), LoginAttempt.created_at > since)
        )
    if by_email >= s.login_max_failures_per_email or by_ip >= s.login_max_failures_per_ip:
        raise ApiError(429, "login_throttled", "Too many failed logins. Try again later.")


@dataclass
class KeyPrincipal:
    user: User
    key: ApiKey
    raw_key: str


async def api_key_principal(request: Request, db: AsyncSession) -> KeyPrincipal:
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        raise ApiError(401, "missing_api_key", "Provide an API key as 'Authorization: Bearer <key>'.")
    raw = auth[7:].strip()
    if not raw:
        raise ApiError(401, "missing_api_key", "Empty API key.")
    row = (
        await db.execute(
            select(ApiKey, User).join(User, User.id == ApiKey.user_id).where(ApiKey.fingerprint == key_fingerprint(raw))
        )
    ).first()
    if not row:
        raise ApiError(401, "invalid_api_key", "Invalid API key.")
    key, user = row
    if key.status != "active":
        raise ApiError(401, "invalid_api_key", "This API key has been revoked.")
    if key.expires_at is not None and key.expires_at <= now():
        raise ApiError(401, "expired_api_key", "This API key has expired.")
    if user.status != "active":
        raise ApiError(403, "account_disabled", "This account is disabled.")
    return KeyPrincipal(user=user, key=key, raw_key=raw)
