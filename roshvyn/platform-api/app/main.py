"""FastAPI application: platform API (/platform/v1) + OpenAI-compatible inference (/v1)."""

from __future__ import annotations

import logging
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, OperationalError

from . import billing
from .config import get_settings
from .db import dispose, sessionmaker
from .errors import ApiError, api_error_handler, error_body, request_id_of
from .inference import router as inference_router
from .routes_admin import router as admin_router
from .routes_platform import router as platform_router

log = logging.getLogger("roshvyn")


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()
    for name in ("key_hmac_secret", "session_secret"):
        if len(getattr(s, name)) < 32:
            raise RuntimeError(f"ROSHVYN_{name.upper()} must be set to at least 32 characters")
    async with sessionmaker()() as db:
        result = await billing.recover_after_restart(db)
    log.warning("startup recovery: %s", result)
    app.state.recovery = result
    yield
    await dispose()


app = FastAPI(title="Roshvyn Platform API", version="0.1.0", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.add_exception_handler(ApiError, api_error_handler)

if get_settings().cors_origins:
    app.add_middleware(CORSMiddleware, allow_origins=get_settings().cors_origins, allow_credentials=True,
                       allow_methods=["GET", "POST", "PATCH", "DELETE"], allow_headers=["content-type", "x-csrf-token", "authorization"])


@app.middleware("http")
async def attach_request_id(request: Request, call_next):
    request.state.request_id = str(uuid.uuid4())
    response = await call_next(request)
    response.headers.setdefault("x-request-id", request.state.request_id)
    return response


@app.exception_handler(RequestValidationError)
async def validation_handler(request: Request, exc: RequestValidationError):
    rid = request_id_of(request)
    first = exc.errors()[0] if exc.errors() else {}
    msg = f"{'.'.join(str(x) for x in first.get('loc', []))}: {first.get('msg', 'invalid request')}"
    return JSONResponse(error_body(400, "invalid_request", msg, rid), status_code=400)


@app.exception_handler(OperationalError)
@app.exception_handler(DBAPIError)
@app.exception_handler(OSError)
async def database_down(request: Request, exc: Exception):
    # Fail closed: no inference or account change happens without the billing database.
    rid = request_id_of(request)
    log.error("database unavailable (%s) %s", type(exc).__name__, rid)
    return JSONResponse(error_body(503, "billing_unavailable", "Billing database unavailable; request not accepted.", rid),
                        status_code=503)


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception):
    rid = request_id_of(request)
    log.exception("unhandled error %s", rid)
    return JSONResponse(error_body(500, "internal_error", "Internal server error.", rid), status_code=500)


@app.get("/platform/v1/health")
async def health():
    try:
        async with sessionmaker()() as db:
            await db.execute(text("select 1"))
        db_ok = True
    except Exception:
        db_ok = False
    return JSONResponse({"status": "ok" if db_ok else "degraded", "database": db_ok, "profile": get_settings().profile},
                        status_code=200 if db_ok else 503)


app.include_router(platform_router)
app.include_router(admin_router)
app.include_router(inference_router)
