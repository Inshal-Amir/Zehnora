"""Public OpenAI-compatible inference surface (/v1) and the shared pipeline.

Request path: key/account validation -> atomic credit reservation -> LiteLLM ->
upstream -> response/stream -> settlement on actual usage (brief section 4).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid

import httpx
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from . import billing
from .auth import api_key_principal, now
from .config import get_settings
from .db import get_db, sessionmaker
from .errors import ApiError, error_body
from .models import ApiKey, ModelCatalog, User

log = logging.getLogger("zehnora.inference")
router = APIRouter()

_inflight = 0
_inflight_lock = asyncio.Lock()
_background: set[asyncio.Task] = set()


class _Slot:
    """Non-blocking capacity slot: beyond max_inflight_requests we answer 429."""

    async def __aenter__(self):
        global _inflight
        async with _inflight_lock:
            if _inflight >= get_settings().max_inflight_requests:
                raise ApiError(429, "capacity_exceeded", "The model is at capacity. Retry shortly.")
            _inflight += 1
        return self

    async def __aexit__(self, *exc):
        global _inflight
        async with _inflight_lock:
            _inflight -= 1


async def acquire_slot() -> _Slot:
    slot = _Slot()
    await slot.__aenter__()
    return slot


async def load_model(db: AsyncSession, alias: str | None, allowed: list[str] | None) -> ModelCatalog:
    if not alias:
        raise ApiError(400, "model_required", "'model' is required.")
    model = await db.scalar(select(ModelCatalog).where(ModelCatalog.alias == alias))
    if model is None or not model.is_visible:
        raise ApiError(404, "model_not_found", f"Model '{alias}' does not exist.")
    if allowed is not None and alias not in allowed:
        raise ApiError(403, "model_not_permitted", f"This key is not permitted to use '{alias}'.")
    if not model.is_available:
        raise ApiError(503, "model_unavailable", f"Model '{alias}' is currently unavailable.")
    return model


def _usage_of(obj: dict) -> tuple[int, int] | None:
    u = obj.get("usage") if isinstance(obj, dict) else None
    if not u or u.get("prompt_tokens") is None or u.get("completion_tokens") is None:
        return None
    return int(u["prompt_tokens"]), int(u["completion_tokens"])


def _upstream_error(status: int, text: str, rid: str) -> ApiError:
    try:
        msg = json.loads(text)["error"]["message"]
    except Exception:
        msg = text[:300] or f"HTTP {status}"
    if status in (401, 403):
        return ApiError(403, "gateway_rejected", "The model gateway rejected this key or model.", rid)
    if status == 400:
        return ApiError(400, "upstream_bad_request", f"Model rejected the request: {msg}", rid)
    if status == 429:
        return ApiError(429, "upstream_capacity", "The model is at capacity. Retry shortly.", rid)
    return ApiError(503, "model_unavailable", f"Model service error (HTTP {status}).", rid)


async def run_completion(*, user: User, model: ModelCatalog, body: dict, gateway_key: str, source: str,
                         api_key_id: uuid.UUID | None, db: AsyncSession):
    """Shared pipeline. Returns a JSON dict (non-stream) or a StreamingResponse."""
    stream = bool(body.get("stream"))
    adm = await billing.admit(db, user=user, model=model, body=body, source=source, api_key_id=api_key_id, stream=stream)
    rid = str(adm.request_id)
    upstream_body = dict(adm.body)
    client_wants_usage = bool((upstream_body.get("stream_options") or {}).get("include_usage"))
    if stream:
        upstream_body["stream_options"] = {**(upstream_body.get("stream_options") or {}), "include_usage": True}
    upstream_body["metadata"] = {"zehnora_request_id": rid}
    headers = {"Authorization": f"Bearer {gateway_key}", "Content-Type": "application/json"}
    url = f"{get_settings().litellm_base_url}/v1/chat/completions"
    client = httpx.AsyncClient(timeout=httpx.Timeout(get_settings().upstream_timeout_s, connect=10))
    started = time.monotonic()
    try:
        await billing.mark_dispatched(db, adm.request_id)
        req = client.build_request("POST", url, json=upstream_body, headers=headers)
        resp = await client.send(req, stream=stream)
    except httpx.HTTPError as exc:
        await client.aclose()
        # Connection never established -> no generation happened.
        await billing.release(db, adm.request_id, upstream_status=None, error_code="gateway_unreachable", note=type(exc).__name__)
        raise ApiError(503, "model_unavailable", "Model gateway unreachable.", rid) from exc

    if resp.status_code != 200:
        text = (await resp.aread()).decode("utf-8", "replace")
        await resp.aclose()
        await client.aclose()
        await billing.release(db, adm.request_id, upstream_status=resp.status_code, error_code="upstream_error", note=text[:300])
        raise _upstream_error(resp.status_code, text, rid)

    if not stream:
        try:
            data = resp.json()
        finally:
            await resp.aclose()
            await client.aclose()
        usage = _usage_of(data)
        if usage is None:
            await billing.mark_pending(db, adm.request_id, "upstream returned no usage")
        else:
            await billing.settle(db, adm.request_id, input_tokens=usage[0], output_tokens=usage[1])
        data["id"] = data.get("id") or rid
        return data, rid

    return StreamingResponse(_stream(resp, client, adm.request_id, client_wants_usage, started),
                             media_type="text/event-stream",
                             headers={"x-request-id": rid, "cache-control": "no-cache", "x-accel-buffering": "no"}), rid


async def _finish_stream(request_id: uuid.UUID, usage, reason: str | None, finished: bool = True):
    """Settle only a stream that really finished. A stream that stopped without a finish_reason
    may carry a gateway-computed usage estimate (LiteLLM fills one in); that is not
    authoritative model usage, so the request waits for reconciliation instead."""
    async with sessionmaker()() as db:
        if usage and finished:
            await billing.settle(db, request_id, input_tokens=usage[0], output_tokens=usage[1])
        else:
            note = reason or "stream ended without usage"
            if usage:
                note += f"; gateway-reported (unverified) usage: {usage[0]} in / {usage[1]} out"
            await billing.mark_pending(db, request_id, note)


_SENTINEL = object()


async def _produce(resp: httpx.Response, client: httpx.AsyncClient, request_id: uuid.UUID,
                   client_wants_usage: bool, queue: asyncio.Queue):
    """Reads upstream independently of the client, captures usage and settles.

    If the client disconnects, the consumer cancels this task after a bounded drain
    window; whatever usage was seen by then decides settle vs pending_reconciliation.
    """
    usage = None
    finished = False
    reason = "stream ended without final usage"
    try:
        async for line in resp.aiter_lines():
            if line.startswith("data: ") and line != "data: [DONE]":
                try:
                    obj = json.loads(line[6:])
                except json.JSONDecodeError:
                    obj = None
                if obj is not None:
                    if any(c.get("finish_reason") for c in obj.get("choices") or []):
                        finished = True
                    u = _usage_of(obj)
                    if u:
                        usage = u
                        # We requested the usage-only chunk for settlement; forward it only
                        # when the client asked for it, so the client's stream is unchanged.
                        if not obj.get("choices") and not client_wants_usage:
                            continue
            queue.put_nowait(line)
        if not finished:
            reason = "upstream stream ended without a finish_reason (incomplete generation)"
    except asyncio.CancelledError:
        reason = "client disconnected; final usage not received within the drain window"
    except httpx.HTTPError as exc:
        # Upstream broke mid-stream: tokens may already be sent, so never retry.
        reason = f"upstream stream interrupted: {type(exc).__name__}"
        queue.put_nowait("data: " + json.dumps(error_body(502, "upstream_stream_error", "Model stream interrupted.", str(request_id))))
        queue.put_nowait("")
    finally:
        await resp.aclose()  # also cancels upstream generation if it is still running
        await client.aclose()
        await _finish_stream(request_id, usage, reason, finished)
        queue.put_nowait(_SENTINEL)


async def _stream(resp: httpx.Response, client: httpx.AsyncClient, request_id: uuid.UUID, client_wants_usage: bool,
                  started: float):
    queue: asyncio.Queue = asyncio.Queue()
    producer = asyncio.create_task(_produce(resp, client, request_id, client_wants_usage, queue))
    _background.add(producer)
    producer.add_done_callback(_background.discard)
    try:
        while True:
            item = await queue.get()
            if item is _SENTINEL:
                break
            yield (item + "\n").encode() if item else b"\n"
    finally:
        if not producer.done():
            # Client disconnected: allow a bounded drain for final usage, then cancel upstream.
            asyncio.get_running_loop().call_later(get_settings().disconnect_drain_s, producer.cancel)


@router.get("/v1/models")
async def list_models(request: Request, db: AsyncSession = Depends(get_db)):
    principal = await api_key_principal(request, db)
    rows = (await db.scalars(select(ModelCatalog).where(ModelCatalog.is_visible.is_(True),
                                                        ModelCatalog.alias.in_(principal.key.allowed_models)))).all()
    return {"object": "list", "data": [{"id": m.alias, "object": "model", "owned_by": "zehnora",
                                        "context_length": m.context_limit, "available": m.is_available} for m in rows]}


@router.post("/v1/chat/completions")
async def chat_completions(request: Request, db: AsyncSession = Depends(get_db)):
    try:
        body = await request.json()
    except Exception as exc:
        raise ApiError(400, "invalid_json", "Request body must be JSON.") from exc
    if not isinstance(body, dict):
        raise ApiError(400, "invalid_json", "Request body must be a JSON object.")
    principal = await api_key_principal(request, db)
    model = await load_model(db, body.get("model"), principal.key.allowed_models)
    slot = await acquire_slot()
    try:
        result, rid = await run_completion(user=principal.user, model=model, body=body, gateway_key=principal.raw_key,
                                           source="api", api_key_id=principal.key.id, db=db)
    except BaseException:
        await slot.__aexit__(None, None, None)
        raise
    await db.execute(update(ApiKey).where(ApiKey.id == principal.key.id).values(last_used_at=now()))
    await db.commit()
    if isinstance(result, StreamingResponse):
        inner = result.body_iterator

        async def release_slot_after():
            try:
                async for chunk in inner:
                    yield chunk
            finally:
                await inner.aclose()
                await slot.__aexit__(None, None, None)

        result.body_iterator = release_slot_after()
        return result
    await slot.__aexit__(None, None, None)
    return JSONResponse(result, headers={"x-request-id": rid})
