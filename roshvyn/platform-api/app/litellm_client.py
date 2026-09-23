"""Calls to LiteLLM's supported key-management API (never its tables directly).

Verified against litellm 1.102.0: POST /key/generate returns `key` (the secret)
and `token_id` (hashed id); POST /key/delete accepts {"keys": [token_id]}.
"""

from __future__ import annotations

import httpx

from .config import get_settings
from .errors import ApiError


def _headers() -> dict[str, str]:
    master = get_settings().litellm_master_key
    if not master:
        raise ApiError(503, "gateway_not_configured", "Model gateway is not configured.")
    return {"Authorization": f"Bearer {master}", "Content-Type": "application/json"}


async def generate_key(*, models: list[str], alias: str, metadata: dict) -> tuple[str, str]:
    body = {"models": models, "key_alias": alias, "metadata": metadata}
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.post(f"{get_settings().litellm_base_url}/key/generate", json=body, headers=_headers())
    except httpx.HTTPError as exc:
        raise ApiError(503, "gateway_unavailable", f"Model gateway unavailable: {type(exc).__name__}") from exc
    if r.status_code != 200:
        raise ApiError(503, "gateway_key_error", f"Gateway refused key creation (HTTP {r.status_code}).")
    data = r.json()
    return data["key"], data.get("token_id") or data["token"]


async def delete_key(token_id: str) -> bool:
    """Returns True if the gateway confirmed deletion (or the key no longer exists)."""
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.post(f"{get_settings().litellm_base_url}/key/delete", json={"keys": [token_id]}, headers=_headers())
    except httpx.HTTPError:
        return False
    if r.status_code == 200:
        return True
    # LiteLLM answers 400/404 when the key is already gone; treat as revoked.
    return r.status_code in (400, 404) and "not found" in r.text.lower()
