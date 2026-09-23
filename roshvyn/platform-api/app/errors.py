"""OpenAI-style error objects with a request id.

Status codes (brief 6.6): 400 invalid request, 401 invalid key, 402 insufficient
credits, 403 disabled/forbidden, 404 not found, 409 conflict, 429 capacity/rate
limit, 503 unavailable model/service (including billing database).
"""

from __future__ import annotations

import uuid

from fastapi import Request
from fastapi.responses import JSONResponse

TYPES = {
    400: "invalid_request_error",
    401: "authentication_error",
    402: "insufficient_credits",
    403: "permission_error",
    404: "not_found_error",
    409: "conflict_error",
    429: "rate_limit_error",
    500: "server_error",
    502: "upstream_error",
    503: "service_unavailable",
}


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, request_id: str | None = None):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message
        self.request_id = request_id


def error_body(status: int, code: str, message: str, request_id: str) -> dict:
    return {"error": {"message": message, "type": TYPES.get(status, "server_error"), "code": code}, "request_id": request_id}


def request_id_of(request: Request) -> str:
    rid = getattr(request.state, "request_id", None)
    if not rid:
        rid = str(uuid.uuid4())
        request.state.request_id = rid
    return rid


async def api_error_handler(request: Request, exc: ApiError) -> JSONResponse:
    rid = exc.request_id or request_id_of(request)
    return JSONResponse(error_body(exc.status, exc.code, exc.message, rid), status_code=exc.status,
                        headers={"x-request-id": rid})
