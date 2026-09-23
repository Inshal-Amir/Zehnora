"""Administrator API under /platform/v1/admin (admin session + CSRF required)."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from . import billing
from .auth import Principal, admin_session, client_ip
from .config import get_settings
from .db import get_db
from .errors import ApiError
from .models import ApiKey, AuditEvent, CreditLedger, InferenceRequest, ModelCatalog, ModelRate, User, Wallet
from .routes_platform import _key_view, _user_view, _wallet_view, revoke_key_row

router = APIRouter(prefix="/platform/v1/admin")


async def _user_or_404(db: AsyncSession, user_id: uuid.UUID) -> User:
    user = await db.get(User, user_id)
    if user is None:
        raise ApiError(404, "user_not_found", "User not found.")
    return user


@router.get("/users")
async def list_users(q: str | None = None, _: Principal = Depends(admin_session), db: AsyncSession = Depends(get_db)):
    stmt = select(User, Wallet).outerjoin(Wallet, Wallet.user_id == User.id).order_by(User.created_at.desc()).limit(200)
    if q:
        stmt = stmt.where(User.email.ilike(f"%{q.strip().lower()}%"))
    rows = (await db.execute(stmt)).all()
    return {"users": [{**_user_view(u), "wallet": _wallet_view(w)} for u, w in rows]}


@router.get("/users/{user_id}")
async def user_detail(user_id: uuid.UUID, _: Principal = Depends(admin_session), db: AsyncSession = Depends(get_db)):
    user = await _user_or_404(db, user_id)
    wallet = await db.get(Wallet, user_id)
    keys = (await db.scalars(select(ApiKey).where(ApiKey.user_id == user_id))).all()
    totals = (await db.execute(select(func.count(), func.coalesce(func.sum(InferenceRequest.charged_units), 0))
                               .where(InferenceRequest.user_id == user_id))).one()
    ledger = (await db.scalars(select(CreditLedger).where(CreditLedger.user_id == user_id).order_by(CreditLedger.id.desc()).limit(100))).all()
    return {"user": _user_view(user), "wallet": _wallet_view(wallet), "keys": [_key_view(k) for k in keys],
            "usage": {"requests": totals[0], "charged_units": totals[1]},
            "ledger": [{"id": e.id, "kind": e.kind, "amount_units": e.amount_units, "balance_after_units": e.balance_after_units,
                        "reason": e.reason, "actor_user_id": str(e.actor_user_id) if e.actor_user_id else None,
                        "operation_id": e.operation_id, "created_at": e.created_at.isoformat()} for e in ledger]}


class CreditGrant(BaseModel):
    credits: float | None = Field(default=None, gt=0)
    units: int | None = Field(default=None, gt=0)
    reason: str = Field(min_length=3, max_length=500)
    operation_id: str | None = Field(default=None, max_length=150)


@router.post("/users/{user_id}/credits")
async def grant_credits(user_id: uuid.UUID, body: CreditGrant, request: Request, p: Principal = Depends(admin_session),
                        db: AsyncSession = Depends(get_db)):
    await _user_or_404(db, user_id)
    units = body.units if body.units is not None else round((body.credits or 0) * get_settings().units_per_credit)
    if units <= 0:
        raise ApiError(400, "invalid_amount", "Provide a positive 'credits' or 'units' value.")
    op = body.operation_id or f"grant:{uuid.uuid4()}"
    wallet = await billing.grant(db, user_id=user_id, units=units, actor_user_id=p.user.id, reason=body.reason, operation_id=op)
    db.add(AuditEvent(actor_user_id=p.user.id, action="credits.grant", target_type="user", target_id=str(user_id),
                      details={"units": units, "reason": body.reason, "operation_id": op}, ip=client_ip(request)))
    await db.commit()
    return {"wallet": _wallet_view(wallet), "operation_id": op}


class CreditAdjust(BaseModel):
    delta_units: int
    reason: str = Field(min_length=3, max_length=500)
    operation_id: str | None = Field(default=None, max_length=150)


@router.post("/users/{user_id}/adjust")
async def adjust_credits(user_id: uuid.UUID, body: CreditAdjust, request: Request, p: Principal = Depends(admin_session),
                         db: AsyncSession = Depends(get_db)):
    await _user_or_404(db, user_id)
    if body.delta_units == 0:
        raise ApiError(400, "invalid_amount", "Adjustment must be non-zero.")
    op = body.operation_id or f"adjust:{uuid.uuid4()}"
    wallet = await billing.grant(db, user_id=user_id, units=body.delta_units, actor_user_id=p.user.id, reason=body.reason,
                                 operation_id=op, kind="adjustment")
    db.add(AuditEvent(actor_user_id=p.user.id, action="credits.adjust", target_type="user", target_id=str(user_id),
                      details={"delta_units": body.delta_units, "reason": body.reason, "operation_id": op}, ip=client_ip(request)))
    await db.commit()
    return {"wallet": _wallet_view(wallet), "operation_id": op}


class StatusChange(BaseModel):
    status: str = Field(pattern="^(active|disabled)$")
    reason: str = Field(min_length=3, max_length=500)


@router.post("/users/{user_id}/status")
async def set_status(user_id: uuid.UUID, body: StatusChange, request: Request, p: Principal = Depends(admin_session),
                     db: AsyncSession = Depends(get_db)):
    user = await _user_or_404(db, user_id)
    if user.id == p.user.id and body.status == "disabled":
        raise ApiError(400, "cannot_disable_self", "Administrators cannot disable their own account.")
    user.status = body.status
    db.add(AuditEvent(actor_user_id=p.user.id, action=f"user.{body.status}", target_type="user", target_id=str(user_id),
                      details={"reason": body.reason}, ip=client_ip(request)))
    await db.commit()
    revoked = 0
    if body.status == "disabled":
        for k in (await db.scalars(select(ApiKey).where(ApiKey.user_id == user_id, ApiKey.status == "active"))).all():
            await revoke_key_row(db, k)
            revoked += 1
    return {"user": _user_view(user), "revoked_keys": revoked}


@router.get("/models")
async def admin_models(_: Principal = Depends(admin_session), db: AsyncSession = Depends(get_db)):
    out = []
    for m in (await db.scalars(select(ModelCatalog))).all():
        rates = (await db.scalars(select(ModelRate).where(ModelRate.model_id == m.id).order_by(ModelRate.version))).all()
        out.append({"id": str(m.id), "alias": m.alias, "deployment_identity": m.deployment_identity, "visible": m.is_visible,
                    "available": m.is_available, "context_limit": m.context_limit, "max_output_tokens": m.max_output_limit,
                    "default_output_tokens": m.default_output_tokens,
                    "rates": [{"version": r.version, "input": r.input_units_per_token, "output": r.output_units_per_token,
                               "effective_from": r.effective_from.isoformat()} for r in rates]})
    return {"models": out, "profile": get_settings().profile}


class ModelPatch(BaseModel):
    visible: bool | None = None
    available: bool | None = None


@router.patch("/models/{model_id}")
async def patch_model(model_id: uuid.UUID, body: ModelPatch, request: Request, p: Principal = Depends(admin_session),
                      db: AsyncSession = Depends(get_db)):
    m = await db.get(ModelCatalog, model_id)
    if m is None:
        raise ApiError(404, "model_not_found", "Model not found.")
    if body.visible is not None:
        m.is_visible = body.visible
    if body.available is not None:
        m.is_available = body.available
    db.add(AuditEvent(actor_user_id=p.user.id, action="model.update", target_type="model", target_id=str(m.id),
                      details=body.model_dump(exclude_none=True), ip=client_ip(request)))
    await db.commit()
    return {"ok": True}


class RateCreate(BaseModel):
    input_units_per_token: int = Field(ge=0, le=1_000_000)
    output_units_per_token: int = Field(ge=0, le=1_000_000)


@router.post("/models/{model_id}/rates", status_code=201)
async def new_rate(model_id: uuid.UUID, body: RateCreate, request: Request, p: Principal = Depends(admin_session),
                   db: AsyncSession = Depends(get_db)):
    if await db.get(ModelCatalog, model_id) is None:
        raise ApiError(404, "model_not_found", "Model not found.")
    latest = await db.scalar(select(func.max(ModelRate.version)).where(ModelRate.model_id == model_id)) or 0
    rate = ModelRate(model_id=model_id, version=latest + 1, input_units_per_token=body.input_units_per_token,
                     output_units_per_token=body.output_units_per_token, created_by=p.user.id)
    db.add(rate)
    db.add(AuditEvent(actor_user_id=p.user.id, action="model.rate", target_type="model", target_id=str(model_id),
                      details={**body.model_dump(), "version": latest + 1}, ip=client_ip(request)))
    await db.commit()
    return {"version": rate.version}


@router.get("/requests")
async def list_requests(state: str | None = None, _: Principal = Depends(admin_session), db: AsyncSession = Depends(get_db)):
    stmt = select(InferenceRequest).order_by(InferenceRequest.created_at.desc()).limit(200)
    if state:
        stmt = stmt.where(InferenceRequest.state == state)
    rows = (await db.scalars(stmt)).all()
    return {"requests": [{"id": str(r.id), "user_id": str(r.user_id), "model": r.model_alias, "source": r.source, "state": r.state,
                          "reserved_units": r.reserved_units, "charged_units": r.charged_units, "input_tokens": r.input_tokens,
                          "output_tokens": r.output_tokens, "error_code": r.error_code, "note": r.note,
                          "created_at": r.created_at.isoformat()} for r in rows]}


class Resolve(BaseModel):
    action: str = Field(pattern="^(settle|release)$")
    input_tokens: int | None = Field(default=None, ge=0)
    output_tokens: int | None = Field(default=None, ge=0)
    reason: str = Field(min_length=3, max_length=500)


@router.post("/requests/{request_id}/resolve")
async def resolve_request(request_id: uuid.UUID, body: Resolve, request: Request, p: Principal = Depends(admin_session),
                          db: AsyncSession = Depends(get_db)):
    """Manual reconciliation of a pending request, using usage verified from gateway/model logs."""
    req = await db.get(InferenceRequest, request_id)
    if req is None or req.state != "pending_reconciliation":
        raise ApiError(409, "not_pending", "Only pending_reconciliation requests can be resolved.")
    if body.action == "settle":
        if body.input_tokens is None or body.output_tokens is None:
            raise ApiError(400, "usage_required", "Settling needs input_tokens and output_tokens.")
        charged = await billing.settle(db, request_id, input_tokens=body.input_tokens, output_tokens=body.output_tokens,
                                       upstream_status=None, note=f"admin reconciliation: {body.reason}", actor_user_id=p.user.id)
        result = {"charged_units": charged}
    else:
        await billing.release(db, request_id, upstream_status=None, error_code="admin_released", note=f"admin: {body.reason}")
        result = {"released": True}
    db.add(AuditEvent(actor_user_id=p.user.id, action=f"request.{body.action}", target_type="inference_request",
                      target_id=str(request_id), details=body.model_dump(), ip=client_ip(request)))
    await db.commit()
    return result


@router.get("/errors")
async def error_summary(_: Principal = Depends(admin_session), db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(InferenceRequest.error_code, func.count(), func.max(InferenceRequest.created_at))
                             .where(InferenceRequest.error_code.is_not(None)).group_by(InferenceRequest.error_code))).all()
    pending = await db.scalar(select(func.count()).select_from(InferenceRequest).where(InferenceRequest.state == "pending_reconciliation"))
    return {"errors": [{"code": c, "count": n, "last_seen": t.isoformat()} for c, n, t in rows], "pending_reconciliation": pending}


@router.get("/audit")
async def audit(_: Principal = Depends(admin_session), db: AsyncSession = Depends(get_db)):
    rows = (await db.scalars(select(AuditEvent).order_by(AuditEvent.id.desc()).limit(200))).all()
    return {"events": [{"id": e.id, "actor": str(e.actor_user_id) if e.actor_user_id else None, "action": e.action,
                        "target_type": e.target_type, "target_id": e.target_id, "details": e.details,
                        "created_at": e.created_at.isoformat()} for e in rows]}
