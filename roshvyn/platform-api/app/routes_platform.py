"""Customer portal API under /platform/v1 (session-cookie authenticated)."""

from __future__ import annotations

import uuid
from datetime import timedelta

from email_validator import EmailNotValidError, validate_email
from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from . import litellm_client
from .auth import (
    CSRF_COOKIE,
    SESSION_COOKIE,
    Principal,
    check_login_throttle,
    client_ip,
    current_session,
    now,
)
from .billing import current_rate
from .config import get_settings
from .db import get_db
from .errors import ApiError
from .inference import acquire_slot, load_model, run_completion
from .models import (
    ApiKey,
    AuditEvent,
    CreditLedger,
    InferenceRequest,
    LoginAttempt,
    ModelCatalog,
    PlaygroundConversation,
    PlaygroundMessage,
    Session,
    User,
    Wallet,
)
from .security import DUMMY_HASH, csrf_for_session, hash_password, key_fingerprint, new_token, sha256_hex, verify_password

router = APIRouter(prefix="/platform/v1")


def normalize_email(raw: str) -> str:
    try:
        return validate_email(raw.strip(), check_deliverability=False).normalized.lower()
    except EmailNotValidError as exc:
        raise ApiError(400, "invalid_email", "Enter a valid email address.") from exc


class Credentials(BaseModel):
    email: str = Field(max_length=320)
    password: str = Field(max_length=256)


def _user_view(u: User) -> dict:
    return {"id": str(u.id), "email": u.email, "role": u.role, "status": u.status, "created_at": u.created_at.isoformat()}


def _wallet_view(w: Wallet | None) -> dict:
    per = get_settings().units_per_credit
    bal, res = (w.balance_units, w.reserved_units) if w else (0, 0)
    return {"balance_units": bal, "reserved_units": res, "available_units": bal - res,
            "units_per_credit": per, "available_credits": (bal - res) / per, "reserved_credits": res / per}


async def _start_session(db: AsyncSession, user: User, request: Request, response: Response) -> dict:
    token = new_token()
    s = get_settings()
    db.add(Session(user_id=user.id, token_hash=sha256_hex(token), expires_at=now() + timedelta(hours=s.session_hours),
                   user_agent=(request.headers.get("user-agent") or "")[:300], ip=client_ip(request)))
    await db.commit()
    csrf = csrf_for_session(token)
    max_age = s.session_hours * 3600
    response.set_cookie(SESSION_COOKIE, token, max_age=max_age, httponly=True, secure=s.cookie_secure, samesite="lax", path="/")
    response.set_cookie(CSRF_COOKIE, csrf, max_age=max_age, httponly=False, secure=s.cookie_secure, samesite="lax", path="/")
    return {"user": _user_view(user), "csrf_token": csrf}


@router.post("/auth/register", status_code=201)
async def register(body: Credentials, request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    email = normalize_email(body.email)
    if len(body.password) < get_settings().min_password_length:
        raise ApiError(400, "weak_password", f"Password must be at least {get_settings().min_password_length} characters.")
    # Role is never taken from input: every self-registered account is a USER with zero credits.
    user = User(email=email, password_hash=hash_password(body.password), role="user", status="active")
    db.add(user)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise ApiError(409, "email_taken", "An account with this email already exists.") from exc
    db.add(Wallet(user_id=user.id, balance_units=0, reserved_units=0))
    db.add(AuditEvent(actor_user_id=user.id, action="user.register", target_type="user", target_id=str(user.id), ip=client_ip(request)))
    await db.commit()
    return await _start_session(db, user, request, response)


@router.post("/auth/login")
async def login(body: Credentials, request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    email = body.email.strip().lower()
    ip = client_ip(request)
    await check_login_throttle(db, email, ip)
    user = await db.scalar(select(User).where(User.email == email))
    ok = verify_password(body.password, user.password_hash if user else DUMMY_HASH) and user is not None
    db.add(LoginAttempt(email=email, ip=ip, success=bool(ok)))
    await db.commit()
    if not ok:
        raise ApiError(401, "invalid_credentials", "Email or password is incorrect.")
    if user.status != "active":
        raise ApiError(403, "account_disabled", "This account is disabled.")
    return await _start_session(db, user, request, response)


@router.post("/auth/logout")
async def logout(response: Response, p: Principal = Depends(current_session), db: AsyncSession = Depends(get_db)):
    p.session.revoked_at = now()
    db.add(p.session)
    await db.commit()
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.delete_cookie(CSRF_COOKIE, path="/")
    return {"ok": True}


@router.post("/auth/password-reset")
async def password_reset():
    raise ApiError(503, "email_not_configured",
                   "Password reset needs email delivery, which is not configured for this deployment. Contact the administrator.")


@router.get("/session")
async def session_state(request: Request, db: AsyncSession = Depends(get_db)):
    """Always 200: lets the portal check login state without logging a 401 in the browser."""
    try:
        p = await current_session(request, db)
    except ApiError:
        return {"authenticated": False}
    wallet = await db.get(Wallet, p.user.id)
    return {"authenticated": True, "user": _user_view(p.user), "wallet": _wallet_view(wallet),
            "profile": get_settings().profile, "api_base_url": get_settings().public_api_base}


@router.get("/me")
async def me(p: Principal = Depends(current_session), db: AsyncSession = Depends(get_db)):
    wallet = await db.get(Wallet, p.user.id)
    return {"user": _user_view(p.user), "wallet": _wallet_view(wallet), "profile": get_settings().profile,
            "api_base_url": get_settings().public_api_base}


@router.get("/wallet")
async def wallet(p: Principal = Depends(current_session), db: AsyncSession = Depends(get_db)):
    w = await db.get(Wallet, p.user.id)
    ledger = (await db.scalars(select(CreditLedger).where(CreditLedger.user_id == p.user.id)
                               .order_by(CreditLedger.id.desc()).limit(50))).all()
    return {"wallet": _wallet_view(w), "ledger": [
        {"id": e.id, "kind": e.kind, "amount_units": e.amount_units, "balance_after_units": e.balance_after_units,
         "reason": e.reason, "created_at": e.created_at.isoformat()} for e in ledger]}


@router.get("/usage")
async def usage(p: Principal = Depends(current_session), db: AsyncSession = Depends(get_db)):
    rows = (await db.scalars(select(InferenceRequest).where(InferenceRequest.user_id == p.user.id)
                             .order_by(InferenceRequest.created_at.desc()).limit(100))).all()
    totals = (await db.execute(select(func.count(), func.coalesce(func.sum(InferenceRequest.input_tokens), 0),
                                      func.coalesce(func.sum(InferenceRequest.output_tokens), 0),
                                      func.coalesce(func.sum(InferenceRequest.charged_units), 0))
                               .where(InferenceRequest.user_id == p.user.id))).one()
    errors = await db.scalar(select(func.count()).select_from(InferenceRequest).where(
        InferenceRequest.user_id == p.user.id, InferenceRequest.error_code.is_not(None)))
    return {"totals": {"requests": totals[0], "input_tokens": totals[1], "output_tokens": totals[2],
                       "charged_units": totals[3], "errors": errors},
            "requests": [{"id": str(r.id), "model": r.model_alias, "source": r.source, "state": r.state, "stream": r.stream,
                          "input_tokens": r.input_tokens, "output_tokens": r.output_tokens, "charged_units": r.charged_units,
                          "reserved_units": r.reserved_units, "error_code": r.error_code,
                          "created_at": r.created_at.isoformat()} for r in rows]}


@router.get("/models")
async def models(p: Principal = Depends(current_session), db: AsyncSession = Depends(get_db)):
    out = []
    for m in (await db.scalars(select(ModelCatalog).where(ModelCatalog.is_visible.is_(True)))).all():
        rate = await current_rate(db, m.id)
        out.append({"alias": m.alias, "description": m.description, "available": m.is_available,
                    "context_limit": m.context_limit, "max_output_tokens": m.max_output_limit,
                    "input_units_per_token": rate.input_units_per_token, "output_units_per_token": rate.output_units_per_token,
                    "rate_version": rate.version})
    return {"models": out, "note": "Credits are demonstration units assigned by an administrator, not money."}


# ---------------- API keys ----------------

class KeyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    models: list[str] | None = None
    expires_in_days: int | None = Field(default=None, ge=1, le=365)


def _key_view(k: ApiKey) -> dict:
    return {"id": str(k.id), "name": k.name, "display": f"{k.display_prefix}…{k.last4}", "models": k.allowed_models,
            "status": k.status, "created_at": k.created_at.isoformat(),
            "expires_at": k.expires_at.isoformat() if k.expires_at else None,
            "last_used_at": k.last_used_at.isoformat() if k.last_used_at else None,
            "revoked_at": k.revoked_at.isoformat() if k.revoked_at else None}


@router.get("/keys")
async def list_keys(p: Principal = Depends(current_session), db: AsyncSession = Depends(get_db)):
    keys = (await db.scalars(select(ApiKey).where(ApiKey.user_id == p.user.id).order_by(ApiKey.created_at.desc()))).all()
    return {"keys": [_key_view(k) for k in keys]}


@router.post("/keys", status_code=201)
async def create_key(body: KeyCreate, request: Request, p: Principal = Depends(current_session), db: AsyncSession = Depends(get_db)):
    visible = set((await db.scalars(select(ModelCatalog.alias).where(ModelCatalog.is_visible.is_(True)))).all())
    models = body.models or sorted(visible)
    if not models or not set(models) <= visible:
        raise ApiError(400, "invalid_models", "Choose models from the catalog.")
    key_id = uuid.uuid4()
    secret, token_id = await litellm_client.generate_key(
        models=models, alias=f"roshvyn-{key_id}", metadata={"roshvyn_user_id": str(p.user.id), "roshvyn_key_id": str(key_id)})
    try:
        k = ApiKey(id=key_id, user_id=p.user.id, name=body.name.strip(), fingerprint=key_fingerprint(secret),
                   display_prefix=secret[:7], last4=secret[-4:], litellm_key_ref=token_id, allowed_models=models,
                   expires_at=now() + timedelta(days=body.expires_in_days) if body.expires_in_days else None)
        db.add(k)
        db.add(AuditEvent(actor_user_id=p.user.id, action="key.create", target_type="api_key", target_id=str(key_id),
                          details={"models": models}, ip=client_ip(request)))
        await db.commit()
    except Exception:
        # Compensate: never leave an orphan gateway key behind.
        await db.rollback()
        await litellm_client.delete_key(token_id)
        raise
    return {"key": _key_view(k), "secret": secret,
            "notice": "Copy this key now. It is shown once and cannot be recovered."}


async def revoke_key_row(db: AsyncSession, k: ApiKey) -> None:
    """Platform revocation is immediate; gateway deletion is reconciled if it fails."""
    k.status, k.revoked_at, k.gateway_state = "revoked", now(), "revoke_pending"
    await db.commit()
    if await litellm_client.delete_key(k.litellm_key_ref):
        k.gateway_state = "revoked"
        await db.commit()


@router.post("/keys/{key_id}/revoke")
async def revoke_key(key_id: uuid.UUID, request: Request, p: Principal = Depends(current_session), db: AsyncSession = Depends(get_db)):
    k = await db.scalar(select(ApiKey).where(ApiKey.id == key_id, ApiKey.user_id == p.user.id))
    if k is None:
        raise ApiError(404, "key_not_found", "Key not found.")
    if k.status != "revoked":
        db.add(AuditEvent(actor_user_id=p.user.id, action="key.revoke", target_type="api_key", target_id=str(k.id), ip=client_ip(request)))
        await revoke_key_row(db, k)
    return {"key": _key_view(k)}


# ---------------- Playground (PostgreSQL-backed, not LibreChat history) ----------------

class ConversationCreate(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    model: str = "roshvyn-coder"


class MessageCreate(BaseModel):
    content: str = Field(min_length=1, max_length=20000)
    max_tokens: int | None = Field(default=None, ge=1)


async def _own_conversation(db: AsyncSession, user_id, conv_id) -> PlaygroundConversation:
    conv = await db.scalar(select(PlaygroundConversation).where(PlaygroundConversation.id == conv_id,
                                                                PlaygroundConversation.user_id == user_id))
    if conv is None:
        raise ApiError(404, "conversation_not_found", "Conversation not found.")
    return conv


@router.get("/playground/conversations")
async def list_conversations(p: Principal = Depends(current_session), db: AsyncSession = Depends(get_db)):
    convs = (await db.scalars(select(PlaygroundConversation).where(PlaygroundConversation.user_id == p.user.id)
                              .order_by(PlaygroundConversation.updated_at.desc()))).all()
    return {"conversations": [{"id": str(c.id), "title": c.title, "model": c.model_alias,
                               "updated_at": c.updated_at.isoformat()} for c in convs]}


@router.post("/playground/conversations", status_code=201)
async def create_conversation(body: ConversationCreate, p: Principal = Depends(current_session), db: AsyncSession = Depends(get_db)):
    await load_model(db, body.model, None)
    conv = PlaygroundConversation(user_id=p.user.id, title=body.title or "New conversation", model_alias=body.model)
    db.add(conv)
    await db.commit()
    return {"id": str(conv.id), "title": conv.title, "model": conv.model_alias}


@router.get("/playground/conversations/{conv_id}")
async def get_conversation(conv_id: uuid.UUID, p: Principal = Depends(current_session), db: AsyncSession = Depends(get_db)):
    conv = await _own_conversation(db, p.user.id, conv_id)
    msgs = (await db.scalars(select(PlaygroundMessage).where(PlaygroundMessage.conversation_id == conv.id)
                             .order_by(PlaygroundMessage.created_at))).all()
    return {"id": str(conv.id), "title": conv.title, "model": conv.model_alias,
            "messages": [{"id": str(m.id), "role": m.role, "content": m.content, "request_id": str(m.request_id) if m.request_id else None,
                          "created_at": m.created_at.isoformat()} for m in msgs]}


@router.delete("/playground/conversations/{conv_id}")
async def delete_conversation(conv_id: uuid.UUID, p: Principal = Depends(current_session), db: AsyncSession = Depends(get_db)):
    conv = await _own_conversation(db, p.user.id, conv_id)
    await db.execute(delete(PlaygroundConversation).where(PlaygroundConversation.id == conv.id))
    await db.commit()
    return {"deleted": str(conv_id)}


@router.post("/playground/conversations/{conv_id}/messages")
async def send_message(conv_id: uuid.UUID, body: MessageCreate, p: Principal = Depends(current_session),
                       db: AsyncSession = Depends(get_db)):
    conv = await _own_conversation(db, p.user.id, conv_id)
    gateway_key = get_settings().playground_gateway_key
    if not gateway_key:
        raise ApiError(503, "playground_not_configured", "The playground gateway credential is not configured.")
    model = await load_model(db, conv.model_alias, None)
    history = (await db.scalars(select(PlaygroundMessage).where(PlaygroundMessage.conversation_id == conv.id)
                                .order_by(PlaygroundMessage.created_at))).all()
    messages = [{"role": m.role, "content": m.content} for m in history] + [{"role": "user", "content": body.content}]
    req_body = {"model": model.alias, "messages": messages}
    if body.max_tokens:
        req_body["max_tokens"] = body.max_tokens
    slot = await acquire_slot()
    try:
        # Same admission/credit pipeline; account comes from the session, not a customer key.
        data, rid = await run_completion(user=p.user, model=model, body=req_body, gateway_key=gateway_key,
                                         source="playground", api_key_id=None, db=db)
    finally:
        await slot.__aexit__(None, None, None)
    reply = (data["choices"][0]["message"].get("content") or "").strip()
    sent_at = now()
    db.add(PlaygroundMessage(conversation_id=conv.id, role="user", content=body.content, created_at=sent_at))
    db.add(PlaygroundMessage(conversation_id=conv.id, role="assistant", content=reply, request_id=uuid.UUID(rid),
                             created_at=sent_at + timedelta(microseconds=1)))
    if conv.title == "New conversation":
        conv.title = body.content[:60]
    conv.updated_at = now()
    await db.commit()
    return {"reply": reply, "request_id": rid, "usage": data.get("usage")}
