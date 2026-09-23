"""Gate A - platform correctness (brief section 13). Upstream is the development MOCK model."""

from __future__ import annotations

import asyncio
import json
import time
import uuid

import httpx
import psycopg
import pytest

from conftest import BASE, Portal, api, db_conn, grant, unique_email

MSG = [{"role": "user", "content": "hello from the test suite"}]


def wallet(p: Portal) -> dict:
    return p.get("/platform/v1/wallet").json()["wallet"]


def req_row(rid: str):
    with db_conn() as c:
        return c.execute("select state, reserved_units, charged_units, input_tokens, output_tokens from inference_requests "
                         "where id=%s", (rid,)).fetchone()


# ---------- accounts, roles, isolation ----------

def test_register_starts_as_user_with_zero_credits_and_role_is_not_accepted():
    http = httpx.Client(base_url=BASE)
    r = http.post("/platform/v1/auth/register", json={"email": unique_email("sneaky"), "password": "long-enough-pw-1", "role": "admin"})
    assert r.status_code == 201
    assert r.json()["user"]["role"] == "user"
    me = http.get("/platform/v1/me").json()
    assert me["wallet"]["balance_units"] == 0 and me["wallet"]["available_units"] == 0


def test_two_users_are_isolated(admin):
    a, b = Portal(unique_email("a")), Portal(unique_email("b"))
    grant(admin, a, 50_000)
    ka = a.new_key()
    conv = a.post("/platform/v1/playground/conversations", json={"title": "A private"}).json()
    # B sees none of A's resources and cannot act on them.
    assert b.get("/platform/v1/keys").json()["keys"] == []
    assert b.post(f"/platform/v1/keys/{ka['key']['id']}/revoke").status_code == 404
    assert b.get(f"/platform/v1/playground/conversations/{conv['id']}").status_code == 404
    assert b.delete(f"/platform/v1/playground/conversations/{conv['id']}").status_code == 404
    assert wallet(b)["balance_units"] == 0 and wallet(a)["balance_units"] == 50_000
    assert all(r["id"] for r in b.get("/platform/v1/usage").json()["requests"]) and b.get("/platform/v1/usage").json()["totals"]["requests"] == 0
    # A's key still works (B's revoke attempt had no effect).
    assert api(ka["secret"], {"messages": MSG}).status_code == 200


def test_ordinary_user_cannot_use_admin_routes(user):
    assert user.post(f"/platform/v1/admin/users/{user.user['id']}/credits", json={"units": 1000, "reason": "self"}).status_code == 403
    assert user.get("/platform/v1/admin/users").status_code == 403
    assert user.post(f"/platform/v1/admin/users/{user.user['id']}/status", json={"status": "active", "reason": "x" * 5}).status_code == 403


def test_admin_grant_persists_with_reason_and_actor(admin, user):
    grant(admin, user, 12_345, reason="demo credits for review")
    detail = admin.get(f"/platform/v1/admin/users/{user.user['id']}").json()
    entry = detail["ledger"][0]
    assert entry["kind"] == "grant" and entry["amount_units"] == 12_345
    assert entry["reason"] == "demo credits for review" and entry["actor_user_id"] == admin.user["id"]
    assert wallet(user)["balance_units"] == 12_345


def test_duplicate_grant_operation_id_rejected(admin, user):
    op = f"op-{uuid.uuid4()}"
    body = {"units": 1000, "reason": "once only", "operation_id": op}
    assert admin.post(f"/platform/v1/admin/users/{user.user['id']}/credits", json=body).status_code == 200
    assert admin.post(f"/platform/v1/admin/users/{user.user['id']}/credits", json=body).status_code == 409
    assert wallet(user)["balance_units"] == 1000


def test_ledger_is_append_only():
    with db_conn() as c:
        with pytest.raises(psycopg.errors.RaiseException):
            c.execute("update credit_ledger set amount_units = amount_units + 1")
        with pytest.raises(psycopg.errors.RaiseException):
            c.execute("delete from credit_ledger")


def test_csrf_required_for_cookie_mutations(user):
    assert user.post("/platform/v1/keys", json={"name": "no csrf"}, csrf=False).status_code == 403
    r = user.http.post("/platform/v1/keys", json={"name": "bad csrf"}, headers={"x-csrf-token": "forged"})
    assert r.status_code == 403


def test_login_throttling():
    email = unique_email("throttle")
    Portal(email)
    http = httpx.Client(base_url=BASE)
    codes = [http.post("/platform/v1/auth/login", json={"email": email, "password": "wrong-password-x"}).status_code for _ in range(6)]
    assert codes[:5] == [401] * 5 and codes[5] == 429
    # Even the right password is refused while throttled.
    assert http.post("/platform/v1/auth/login", json={"email": email, "password": "correct-horse-battery-9"}).status_code == 429


# ---------- keys ----------

def test_key_shown_once_and_only_prefix_listed(user):
    created = user.new_key("once")
    secret = created["secret"]
    listed = user.get("/platform/v1/keys").json()["keys"][0]
    assert secret not in json.dumps(listed) and listed["display"].endswith(secret[-4:])
    with db_conn() as c:
        row = c.execute("select fingerprint, display_prefix from api_keys where id=%s", (created["key"]["id"],)).fetchone()
    assert secret not in row[0] and len(row[0]) == 64


def test_zero_credit_request_rejected_before_inference(user):
    key = user.new_key()["secret"]
    r = api(key, {"messages": MSG})
    assert r.status_code == 402 and r.json()["error"]["code"] == "insufficient_credits" and r.json()["request_id"]
    with db_conn() as c:
        n = c.execute("select count(*) from inference_requests where user_id=%s", (user.user["id"],)).fetchone()[0]
    assert n == 0  # nothing reserved or dispatched


def test_invalid_and_revoked_keys(admin, user):
    grant(admin, user, 100_000)
    created = user.new_key()
    key = created["secret"]
    assert api("sk-not-a-real-key", {"messages": MSG}).status_code == 401
    assert api(key, {"messages": MSG}).status_code == 200
    assert user.post(f"/platform/v1/keys/{created['key']['id']}/revoke").status_code == 200
    r = api(key, {"messages": MSG})
    assert r.status_code == 401 and "revoked" in r.json()["error"]["message"]
    # The gateway key is gone too (LiteLLM rejects it directly).
    from app.config import get_settings
    direct = httpx.post(f"{get_settings().litellm_base_url}/v1/chat/completions", headers={"Authorization": f"Bearer {key}"},
                        json={"model": "roshvyn-coder", "messages": MSG})
    assert direct.status_code == 401
    with db_conn() as c:
        assert c.execute("select gateway_state from api_keys where id=%s", (created["key"]["id"],)).fetchone()[0] == "revoked"


def test_expired_key_and_model_restriction(admin, user):
    grant(admin, user, 100_000)
    created = user.new_key()
    r = api(created["secret"], {"model": "some-other-model", "messages": MSG})
    assert r.status_code in (403, 404)
    with db_conn() as c:
        c.execute("update api_keys set expires_at = now() - interval '1 minute' where id=%s", (created["key"]["id"],))
    r = api(created["secret"], {"messages": MSG})
    assert r.status_code == 401 and r.json()["error"]["code"] == "expired_api_key"


def test_disable_account_revokes_keys(admin, user):
    grant(admin, user, 100_000)
    key = user.new_key()["secret"]
    r = admin.post(f"/platform/v1/admin/users/{user.user['id']}/status", json={"status": "disabled", "reason": "test disable"})
    assert r.status_code == 200 and r.json()["revoked_keys"] == 1
    assert api(key, {"messages": MSG}).status_code == 401
    assert user.get("/platform/v1/me").status_code == 403


def test_new_keys_share_the_same_wallet(admin, user):
    grant(admin, user, 100_000)
    k1, k2 = user.new_key("one")["secret"], user.new_key("two")["secret"]
    before = wallet(user)["balance_units"]
    assert api(k1, {"messages": MSG}).status_code == 200
    assert api(k2, {"messages": MSG}).status_code == 200
    after = wallet(user)
    assert after["balance_units"] < before and after["reserved_units"] == 0


# ---------- metering ----------

def test_non_stream_charge_matches_actual_usage(admin, user):
    grant(admin, user, 100_000)
    key = user.new_key()["secret"]
    r = api(key, {"messages": MSG, "max_tokens": 50})
    assert r.status_code == 200
    usage, rid = r.json()["usage"], r.headers["x-request-id"]
    state, reserved, charged, it, ot = req_row(rid)
    assert state == "settled" and (it, ot) == (usage["prompt_tokens"], usage["completion_tokens"])
    assert charged == it * 1 + ot * 2 and reserved >= charged
    w = wallet(user)
    assert w["balance_units"] == 100_000 - charged and w["reserved_units"] == 0


def test_output_limit_validation(admin, user):
    grant(admin, user, 100_000)
    key = user.new_key()["secret"]
    assert api(key, {"messages": MSG, "max_tokens": 10, "max_completion_tokens": 20}).status_code == 400
    assert api(key, {"messages": MSG, "max_tokens": 999_999}).status_code == 400
    r = api(key, {"messages": [{"role": "user", "content": "[[mock:long]]"}], "max_completion_tokens": 7})
    assert r.status_code == 200 and r.json()["usage"]["completion_tokens"] == 7


def test_streaming_settles_and_hides_internal_usage_chunk(admin, user):
    grant(admin, user, 100_000)
    key = user.new_key()["secret"]
    r = api(key, {"messages": MSG}, stream=True)
    assert r.status_code == 200
    events = [l[6:] for l in r.text.splitlines() if l.startswith("data: ")]
    assert events[-1] == "[DONE]"
    chunks = [json.loads(e) for e in events[:-1]]
    assert all(c.get("choices") for c in chunks), "usage-only chunk must not leak when not requested"
    text = "".join(c["choices"][0]["delta"].get("content") or "" for c in chunks)
    assert text.startswith("MOCK reply to:")
    time.sleep(0.5)
    state, _, charged, it, ot = req_row(r.headers["x-request-id"])
    assert state == "settled" and charged == it + 2 * ot and wallet(user)["reserved_units"] == 0
    # When the client asks for usage, the usage chunk is forwarded.
    r2 = api(key, {"messages": MSG, "stream_options": {"include_usage": True}}, stream=True)
    usage_chunks = [json.loads(l[6:]) for l in r2.text.splitlines() if l.startswith("data: {") and '"usage"' in l]
    assert usage_chunks and usage_chunks[-1]["usage"]["completion_tokens"] > 0


def test_tool_calls_preserved_non_stream_and_stream(admin, user):
    grant(admin, user, 100_000)
    key = user.new_key()["secret"]
    tools = [{"type": "function", "function": {"name": "read_file", "description": "Read a file",
                                               "parameters": {"type": "object", "properties": {"relative_path": {"type": "string"}},
                                                              "required": ["relative_path"]}}}]
    r = api(key, {"messages": MSG, "tools": tools})
    tc = r.json()["choices"][0]["message"]["tool_calls"][0]
    assert tc["function"]["name"] == "read_file" and json.loads(tc["function"]["arguments"]) == {"relative_path": "mock"}
    assert tc["id"].startswith("call_mock_")
    s = api(key, {"messages": MSG, "tools": tools}, stream=True)
    ids, name, args = set(), "", ""
    for l in s.text.splitlines():
        if l.startswith("data: {"):
            for d in json.loads(l[6:])["choices"][0]["delta"].get("tool_calls") or []:
                ids.add(d.get("id")) if d.get("id") else None
                name += d.get("function", {}).get("name") or ""
                args += d.get("function", {}).get("arguments") or ""
    assert name == "read_file" and json.loads(args) == {"relative_path": "mock"} and len(ids) == 1
    # Tool-result continuation keeps the id pairing.
    follow = api(key, {"messages": MSG + [{"role": "assistant", "content": None, "tool_calls": [tc]},
                                         {"role": "tool", "tool_call_id": tc["id"], "content": "file body"}], "tools": tools})
    assert "MOCK final answer after tool: file body" in follow.json()["choices"][0]["message"]["content"]


def test_upstream_error_releases_reservation(admin, user):
    grant(admin, user, 100_000)
    key = user.new_key()["secret"]
    r = api(key, {"messages": [{"role": "user", "content": "[[mock:error500]]"}]})
    assert r.status_code == 503 and r.json()["request_id"]
    state, _, charged, *_ = req_row(r.json()["request_id"])
    assert state == "released" and charged == 0
    assert wallet(user) == {**wallet(user), "balance_units": 100_000, "reserved_units": 0}


def test_midstream_truncation_is_charged_gateway_reported_delivered_usage(admin, user):
    """LiteLLM 1.102.0 normalises a truncated upstream stream (adds finish_reason=stop and a
    tokenizer-counted usage chunk). Documented policy: partial generations are charged that
    gateway-reported delivered usage - never the whole reservation, never free."""
    grant(admin, user, 100_000)
    key = user.new_key()["secret"]
    r = api(key, {"messages": [{"role": "user", "content": "[[mock:midstream]] please"}]}, stream=True)
    assert r.status_code == 200
    time.sleep(0.5)
    state, reserved, charged, it, ot = req_row(r.headers["x-request-id"])
    assert state == "settled" and 0 < charged == it + 2 * ot < reserved
    assert wallet(user)["reserved_units"] == 0


def test_admin_resolves_pending_request_exactly_once(admin, user):
    grant(admin, user, 100_000)
    from app import billing
    from app.db import dispose, sessionmaker
    from app.models import ModelCatalog, User
    from sqlalchemy import select

    async def make_pending():
        async with sessionmaker()() as db:
            u = await db.get(User, uuid.UUID(user.user["id"]))
            m = await db.scalar(select(ModelCatalog).where(ModelCatalog.alias == "roshvyn-coder"))
            a = await billing.admit(db, user=u, model=m, body={"messages": MSG}, source="api", api_key_id=None, stream=True)
            await billing.mark_dispatched(db, a.request_id)
            await billing.recover_after_restart(db)  # simulated crash during generation
        await dispose()
        return str(a.request_id)

    rid = asyncio.run(make_pending())
    state, reserved, charged, *_ = req_row(rid)
    assert state == "pending_reconciliation" and charged is None
    assert wallet(user)["reserved_units"] == reserved and wallet(user)["balance_units"] == 100_000
    pending = admin.get("/platform/v1/admin/requests?state=pending_reconciliation").json()["requests"]
    assert any(p["id"] == rid for p in pending)
    res = admin.post(f"/platform/v1/admin/requests/{rid}/resolve",
                     json={"action": "settle", "input_tokens": 10, "output_tokens": 3, "reason": "verified in gateway log"})
    assert res.status_code == 200 and res.json()["charged_units"] == 16
    again = admin.post(f"/platform/v1/admin/requests/{rid}/resolve",
                       json={"action": "settle", "input_tokens": 10, "output_tokens": 3, "reason": "duplicate"})
    assert again.status_code == 409
    assert wallet(user)["balance_units"] == 100_000 - 16 and wallet(user)["reserved_units"] == 0


def test_client_disconnect_still_settles_from_drained_usage(admin, user):
    grant(admin, user, 100_000)
    key = user.new_key()["secret"]
    body = {"model": "roshvyn-coder", "stream": True, "messages": [{"role": "user", "content": "[[mock:slow]] one two three four"}]}
    with httpx.stream("POST", f"{BASE}/v1/chat/completions", json=body, headers={"Authorization": f"Bearer {key}"}) as r:
        rid = r.headers["x-request-id"]
        for _ in r.iter_lines():
            break  # read one line, then drop the connection
    for _ in range(40):
        if req_row(rid)[0] != "dispatched":
            break
        time.sleep(0.5)
    state, _, charged, it, ot = req_row(rid)
    assert state == "settled" and charged == it + 2 * ot > 0
    assert wallet(user)["reserved_units"] == 0


# ---------- concurrency ----------

def test_shared_wallet_concurrency_admits_only_affordable_work(admin, user):
    key1, key2 = user.new_key("c1")["secret"], user.new_key("c2")["secret"]
    body = {"model": "roshvyn-coder", "stream": True, "max_tokens": 100,
            "messages": [{"role": "user", "content": "[[mock:slow]] concurrency check"}]}
    # One request reserves bound(in) + 2*100 units. Find it, then grant 1.5x so both fit alone but not together.
    probe = httpx.post(f"{BASE}/v1/chat/completions", json=body, headers={"Authorization": f"Bearer {key1}"})
    need = int(probe.json()["error"]["message"].split("up to ")[1].split(" units")[0])
    grant(admin, user, int(need * 1.5))

    async def fire(key):
        async with httpx.AsyncClient(timeout=60) as c:
            async with c.stream("POST", f"{BASE}/v1/chat/completions", json=body, headers={"Authorization": f"Bearer {key}"}) as r:
                await r.aread()
                return r.status_code

    async def both():
        return await asyncio.gather(fire(key1), fire(key2))

    codes = sorted(asyncio.run(both()))
    assert codes == [200, 402], codes
    time.sleep(0.5)
    w = wallet(user)
    assert w["reserved_units"] == 0 and w["balance_units"] >= 0


# ---------- recovery / idempotency ----------

def test_duplicate_settlement_and_restart_recovery(admin, user):
    grant(admin, user, 100_000)
    from app import billing
    from app.db import dispose, sessionmaker
    from app.models import ModelCatalog, User
    from sqlalchemy import select

    async def scenario():
        async with sessionmaker()() as db:
            u = await db.get(User, uuid.UUID(user.user["id"]))
            m = await db.scalar(select(ModelCatalog).where(ModelCatalog.alias == "roshvyn-coder"))
            a1 = await billing.admit(db, user=u, model=m, body={"messages": MSG}, source="api", api_key_id=None, stream=False)
            first = await billing.settle(db, a1.request_id, input_tokens=5, output_tokens=5)
            second = await billing.settle(db, a1.request_id, input_tokens=5, output_tokens=5)
            a2 = await billing.admit(db, user=u, model=m, body={"messages": MSG}, source="api", api_key_id=None, stream=False)
            a3 = await billing.admit(db, user=u, model=m, body={"messages": MSG}, source="api", api_key_id=None, stream=False)
            await billing.mark_dispatched(db, a3.request_id)
            recovered = await billing.recover_after_restart(db)
        await dispose()
        return first, second, a1.request_id, a2.request_id, a3.request_id, recovered

    first, second, r1, r2, r3, recovered = asyncio.run(scenario())
    assert first == 15 and second is None
    with db_conn() as c:
        assert c.execute("select count(*) from credit_ledger where operation_id=%s", (f"usage:{r1}",)).fetchone()[0] == 1
    assert req_row(str(r2))[0] == "released" and req_row(str(r3))[0] == "pending_reconciliation"
    assert recovered["released"] >= 1 and recovered["pending_reconciliation"] >= 1
    w = wallet(user)
    assert w["balance_units"] == 100_000 - 15 and w["reserved_units"] == req_row(str(r3))[1]


def test_adjustment_cannot_go_below_reservations(admin, user):
    grant(admin, user, 10_000)
    r = admin.post(f"/platform/v1/admin/users/{user.user['id']}/adjust", json={"delta_units": -20_000, "reason": "too much"})
    assert r.status_code == 409
    r = admin.post(f"/platform/v1/admin/users/{user.user['id']}/adjust", json={"delta_units": -4_000, "reason": "correction"})
    assert r.status_code == 200 and wallet(user)["balance_units"] == 6_000


# ---------- playground ----------

def test_playground_uses_account_wallet_and_persists(admin, user):
    grant(admin, user, 100_000)
    conv = user.post("/platform/v1/playground/conversations", json={}).json()
    r = user.post(f"/platform/v1/playground/conversations/{conv['id']}/messages", json={"content": "playground hello"})
    assert r.status_code == 200 and r.json()["reply"].startswith("MOCK reply to: playground hello")
    msgs = user.get(f"/platform/v1/playground/conversations/{conv['id']}").json()["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant"]
    usage = user.get("/platform/v1/usage").json()
    assert usage["requests"][0]["source"] == "playground" and usage["requests"][0]["state"] == "settled"
    assert wallet(user)["balance_units"] < 100_000
    assert user.delete(f"/platform/v1/playground/conversations/{conv['id']}").status_code == 200
    assert user.get(f"/platform/v1/playground/conversations/{conv['id']}").status_code == 404


def test_playground_zero_credits_rejected(user):
    conv = user.post("/platform/v1/playground/conversations", json={}).json()
    r = user.post(f"/platform/v1/playground/conversations/{conv['id']}/messages", json={"content": "hi"})
    assert r.status_code == 402
