"""Credit wallet: admission estimate, atomic reservation, settlement, release.

Rules (brief 6.5, documented in docs/CREDITS-AND-RECOVERY.md):
- Integer units only. Charge = input_tokens*input_rate + output_tokens*output_rate.
- Reservation happens under SELECT ... FOR UPDATE on the account's wallet row, so
  all keys of one account share one pool and concurrent requests cannot overspend.
- Settlement and release are idempotent: they only act on a request that is still
  open (state reserved/dispatched/pending_reconciliation) and write a ledger row
  with a unique operation id, so duplicate callbacks cannot debit twice.
- If generation started but usage is unknown, the request becomes
  pending_reconciliation and keeps its reservation until resolved.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass

from sqlalchemy import select, update
from sqlalchemy.exc import DBAPIError, OperationalError
from sqlalchemy.ext.asyncio import AsyncSession

from .auth import now
from .config import get_settings
from .errors import ApiError
from .models import CreditLedger, InferenceRequest, ModelCatalog, ModelRate, User, Wallet

OPEN_STATES = ("reserved", "dispatched", "pending_reconciliation")


@dataclass
class Admission:
    request_id: uuid.UUID
    model: ModelCatalog
    max_output_tokens: int
    input_token_bound: int
    reserved_units: int
    body: dict  # normalized upstream body


def _content_bytes(value) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def input_token_upper_bound(body: dict, context_limit: int) -> int:
    """Safe upper bound on prompt tokens without a tokenizer.

    Byte-level BPE (the Qwen family) emits tokens that each decode to >= 1 byte,
    so text tokens <= UTF-8 bytes. Chat-template special tokens and the tool
    preamble are covered by fixed overheads. Capped at the enforced context limit.
    """
    s = get_settings()
    messages = body.get("messages") or []
    raw = _content_bytes(messages) + (_content_bytes(body.get("tools")) if body.get("tools") else 0)
    bound = raw + s.per_message_overhead_tokens * len(messages) + s.template_overhead_tokens
    return min(bound, context_limit)


def normalize_request(body: dict, model: ModelCatalog) -> tuple[dict, int]:
    """Validate/normalize output limits; returns (upstream body, enforced max output tokens)."""
    if not isinstance(body.get("messages"), list) or not body["messages"]:
        raise ApiError(400, "invalid_messages", "'messages' must be a non-empty list.")
    mt, mct = body.get("max_tokens"), body.get("max_completion_tokens")
    for name, value in (("max_tokens", mt), ("max_completion_tokens", mct)):
        if value is not None and (not isinstance(value, int) or isinstance(value, bool) or value < 1):
            raise ApiError(400, "invalid_max_tokens", f"'{name}' must be a positive integer.")
    if mt is not None and mct is not None and mt != mct:
        raise ApiError(400, "conflicting_max_tokens", "'max_tokens' and 'max_completion_tokens' differ; send one.")
    requested = mct if mct is not None else mt
    if requested is None:
        requested = model.default_output_tokens
    if requested > model.max_output_limit:
        raise ApiError(400, "max_tokens_too_large", f"Output limit for {model.alias} is {model.max_output_limit} tokens.")
    if body.get("n") not in (None, 1):
        raise ApiError(400, "unsupported_n", "Only n=1 is supported.")
    for forbidden in ("api_base", "base_url", "api_key", "user_api_key", "litellm_params"):
        if forbidden in body:
            raise ApiError(400, "forbidden_parameter", f"Parameter '{forbidden}' is not allowed.")
    out = {k: v for k, v in body.items() if k not in ("max_completion_tokens", "metadata")}
    out["max_tokens"] = requested
    out["model"] = model.alias
    return out, requested


async def current_rate(db: AsyncSession, model_id: uuid.UUID) -> ModelRate:
    rate = await db.scalar(select(ModelRate).where(ModelRate.model_id == model_id).order_by(ModelRate.version.desc()).limit(1))
    if rate is None:
        raise ApiError(503, "model_rate_missing", "No credit rate is configured for this model.")
    return rate


async def admit(db: AsyncSession, *, user: User, model: ModelCatalog, body: dict, source: str,
                api_key_id: uuid.UUID | None, stream: bool) -> Admission:
    """Validate, estimate and atomically reserve credits. Commits on success."""
    upstream_body, max_out = normalize_request(body, model)
    in_bound = input_token_upper_bound(upstream_body, model.context_limit)
    try:
        rate = await current_rate(db, model.id)
        reserve = in_bound * rate.input_units_per_token + max_out * rate.output_units_per_token
        wallet = await db.scalar(select(Wallet).where(Wallet.user_id == user.id).with_for_update())
        if wallet is None:
            raise ApiError(402, "insufficient_credits", "No credits available. Demo credits are assigned by an administrator.")
        available = wallet.balance_units - wallet.reserved_units
        if available < reserve:
            await db.commit()  # nothing changed; commit (not rollback) so loaded ORM objects stay usable
            raise ApiError(402, "insufficient_credits",
                           f"Insufficient credits: this request needs up to {reserve} units, {available} available. "
                           "Demo credits are assigned by an administrator.")
        wallet.reserved_units += reserve
        req = InferenceRequest(user_id=user.id, api_key_id=api_key_id, source=source, model_alias=model.alias,
                               state="reserved", stream=stream, reserved_units=reserve, max_output_tokens=max_out,
                               input_token_bound=in_bound, rate_version=rate.version,
                               input_rate=rate.input_units_per_token, output_rate=rate.output_units_per_token)
        db.add(req)
        await db.commit()
    except ApiError:
        raise
    except (OperationalError, DBAPIError) as exc:
        await db.rollback()
        raise ApiError(503, "billing_unavailable", "Billing database unavailable; request not accepted.") from exc
    return Admission(req.id, model, max_out, in_bound, reserve, upstream_body)


async def mark_dispatched(db: AsyncSession, request_id: uuid.UUID) -> None:
    await db.execute(update(InferenceRequest).where(InferenceRequest.id == request_id, InferenceRequest.state == "reserved")
                     .values(state="dispatched", dispatched_at=now()))
    await db.commit()


async def _lock_open_request(db: AsyncSession, request_id: uuid.UUID) -> InferenceRequest | None:
    return await db.scalar(select(InferenceRequest).where(InferenceRequest.id == request_id,
                                                          InferenceRequest.state.in_(OPEN_STATES)).with_for_update())


async def settle(db: AsyncSession, request_id: uuid.UUID, *, input_tokens: int, output_tokens: int,
                 upstream_status: int | None = 200, note: str | None = None, actor_user_id=None) -> int | None:
    """Charge actual usage once and release the rest. Returns charged units, or None if already closed."""
    req = await _lock_open_request(db, request_id)
    if req is None:
        await db.commit()  # already closed: no-op (commit keeps loaded objects usable)
        return None
    wallet = await db.scalar(select(Wallet).where(Wallet.user_id == req.user_id).with_for_update())
    charge = input_tokens * req.input_rate + output_tokens * req.output_rate
    # Never let the balance go negative: the reservation is an upper bound, but if an upstream
    # ever exceeded it, charge at most what the account holds and record the shortfall.
    capped = min(charge, wallet.balance_units - (wallet.reserved_units - req.reserved_units))
    if capped < charge:
        note = (note + "; " if note else "") + f"usage {charge} exceeded available funds, charged {capped}"
    wallet.reserved_units -= req.reserved_units
    wallet.balance_units -= capped
    req.state, req.input_tokens, req.output_tokens = "settled", input_tokens, output_tokens
    req.charged_units, req.upstream_status, req.completed_at = capped, upstream_status, now()
    req.note = note
    db.add(CreditLedger(user_id=req.user_id, kind="usage", amount_units=-capped, balance_after_units=wallet.balance_units,
                        actor_user_id=actor_user_id, reason=f"{req.source} usage {req.model_alias}: {input_tokens} in / {output_tokens} out",
                        operation_id=f"usage:{req.id}", request_id=req.id))
    await db.commit()
    return capped


async def release(db: AsyncSession, request_id: uuid.UUID, *, upstream_status: int | None, error_code: str | None,
                  note: str | None = None) -> bool:
    """Release the whole reservation (generation never started). Idempotent."""
    req = await _lock_open_request(db, request_id)
    if req is None:
        await db.commit()
        return False
    wallet = await db.scalar(select(Wallet).where(Wallet.user_id == req.user_id).with_for_update())
    wallet.reserved_units -= req.reserved_units
    req.state, req.charged_units, req.upstream_status = "released", 0, upstream_status
    req.error_code, req.note, req.completed_at = error_code, note, now()
    await db.commit()
    return True


async def mark_pending(db: AsyncSession, request_id: uuid.UUID, note: str) -> None:
    await db.execute(update(InferenceRequest).where(InferenceRequest.id == request_id,
                                                    InferenceRequest.state.in_(("reserved", "dispatched")))
                     .values(state="pending_reconciliation", note=note))
    await db.commit()


async def recover_after_restart(db: AsyncSession) -> dict:
    """Reserved-but-never-dispatched -> released. Dispatched -> pending_reconciliation (usage unknown)."""
    never_sent = (await db.scalars(select(InferenceRequest.id).where(InferenceRequest.state == "reserved"))).all()
    for rid in never_sent:
        await release(db, rid, upstream_status=None, error_code="released_on_restart",
                      note="platform restarted before dispatch; no generation occurred")
    in_flight = (await db.scalars(select(InferenceRequest.id).where(InferenceRequest.state == "dispatched"))).all()
    for rid in in_flight:
        await mark_pending(db, rid, "platform restarted during generation; usage unknown - reservation kept")
    return {"released": len(never_sent), "pending_reconciliation": len(in_flight)}


async def grant(db: AsyncSession, *, user_id: uuid.UUID, units: int, actor_user_id, reason: str, operation_id: str,
                kind: str = "grant") -> Wallet:
    """Grant (positive) or adjust (signed) credits. Adjustments cannot push available below zero."""
    if kind == "grant" and units <= 0:
        raise ApiError(400, "invalid_amount", "Grant amount must be positive.")
    if not reason.strip():
        raise ApiError(400, "reason_required", "A reason is required.")
    exists = await db.scalar(select(CreditLedger.id).where(CreditLedger.operation_id == operation_id))
    if exists:
        raise ApiError(409, "duplicate_operation", "This operation id was already applied.")
    wallet = await db.scalar(select(Wallet).where(Wallet.user_id == user_id).with_for_update())
    if wallet is None:
        wallet = Wallet(user_id=user_id, balance_units=0, reserved_units=0)
        db.add(wallet)
        await db.flush()
        wallet = await db.scalar(select(Wallet).where(Wallet.user_id == user_id).with_for_update())
    new_balance = wallet.balance_units + units
    if new_balance < wallet.reserved_units:
        await db.commit()
        raise ApiError(409, "below_reservations",
                       f"Adjustment would leave the balance ({new_balance}) below active reservations ({wallet.reserved_units}).")
    wallet.balance_units = new_balance
    db.add(CreditLedger(user_id=user_id, kind=kind, amount_units=units, balance_after_units=new_balance,
                        actor_user_id=actor_user_id, reason=reason.strip(), operation_id=operation_id))
    await db.commit()
    return wallet
