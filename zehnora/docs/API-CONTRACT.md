# Zehnora API contract

Base URL: `https://api.<OWNER_DOMAIN>/v1` (development: `http://127.0.0.1:8200/v1`). Do not append `/chat/completions` to the base URL in SDKs.
Authentication: `Authorization: Bearer <customer API key>` (keys are created in the portal; shown once).
Model alias: `zehnora-coder`. Inference runs on Zehnora's own model and GPU through a standard OpenAI-compatible format; requests are not sent to OpenAI.

The examples below are **real responses** captured on 2026-09-22 from the development stack (profile `dev-local-4b`: the Qwen3.5-4B stand-in on the Mac). They show the wire format, not GPU performance.

## Supported endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/models` | Aliases permitted for this key |
| POST | `/v1/chat/completions` | `messages`, `model`, `tools`, `tool_choice`, `max_tokens` **or** `max_completion_tokens`, `stream`, `stream_options.include_usage`, sampling fields |

Not supported yet (do not rely on them): `/v1/responses`, embeddings, images, audio, OpenAI-hosted tools, `n > 1`. Parameters `api_base`, `base_url`, `api_key`, `litellm_params` are rejected (no user-supplied upstreams).

### GET /v1/models
```json
{"object":"list","data":[{"id":"zehnora-coder","object":"model","owned_by":"zehnora","context_length":8192,"available":true}]}
```

### POST /v1/chat/completions (non-streaming)
Request: `{"model":"zehnora-coder","max_tokens":12,"messages":[{"role":"user","content":"Say hello in five words."}]}`

Response headers include `x-request-id: 97a26d83-ed84-4d98-bd7d-bf4400dcac57` (the server request id used for billing). Body:
```json
{"id":"chatcmpl-S3izYQpzVPAvUM1XGavtraDrXgRpxWYc","created":1790084065,"model":"zehnora-coder","object":"chat.completion",
 "choices":[{"finish_reason":"stop","index":0,"message":{"content":"Hello, friend, how are you today?","role":"assistant"}}],
 "usage":{"completion_tokens":10,"prompt_tokens":...,"total_tokens":...}}
```
(The gateway also passes through `system_fingerprint` and `provider_specific_fields`; clients should ignore unknown fields.)

### Streaming (SSE)
`"stream": true` returns `text/event-stream` chunks, forwarded as they arrive (no whole-response buffering):
```
data: {"id":"chatcmpl-PdL2…","object":"chat.completion.chunk","model":"zehnora-coder","choices":[{"index":0,"delta":{"role":"assistant"}}]}
data: {"id":"chatcmpl-PdL2…","object":"chat.completion.chunk","model":"zehnora-coder","choices":[{"index":0,"delta":{"content":"1"}}]}
...
data: {"id":"chatcmpl-PdL2…","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}
data: {"id":"chatcmpl-PdL2…","choices":[],"usage":{"prompt_tokens":…,"completion_tokens":…}}   <- only if stream_options.include_usage=true
data: [DONE]
```
The platform always requests final usage upstream for settlement, but forwards the usage-only chunk **only** when the client asked for it, so a client's stream looks exactly as it requested. Requests are never retried after tokens were sent.

### Tool calls
Tool calls come back as structured `tool_calls` (id, function name, JSON arguments), in both non-streaming and streaming form; ids are preserved end to end. The API **does not execute** tools: the caller runs its own tool and sends the result back with `{"role":"tool","tool_call_id":…}`. Verified with the OpenAI SDK and LangChain `bind_tools` (see `zehnora/scripts/test-public-api.py`).

## Errors
Every error has this shape plus an `x-request-id` header:
```json
{"error":{"message":"Invalid API key.","type":"authentication_error","code":"invalid_api_key"},"request_id":"450a4e36-67f5-41ff-8e79-126e81624de8"}
```

| HTTP | code examples | Meaning |
|---|---|---|
| 400 | `conflicting_max_tokens`, `invalid_messages`, `forbidden_parameter` | Invalid request (checked before any reservation) |
| 401 | `missing_api_key`, `invalid_api_key` (also revoked), `expired_api_key` | Key problem |
| 402 | `insufficient_credits` | Not enough available credits for this request's reservation, checked **before** generation |
| 403 | `account_disabled`, `model_not_permitted`, `gateway_rejected` | Forbidden |
| 404 | `model_not_found`, `not_found` | Unknown model or unrouted path |
| 429 | `capacity_exceeded`, `upstream_capacity` | Model at capacity; retry later |
| 503 | `model_unavailable`, `billing_unavailable` | Model or billing database unavailable (fails closed: no untracked inference) |

Real examples:
```json
{"error":{"message":"'max_tokens' and 'max_completion_tokens' differ; send one.","type":"invalid_request_error","code":"conflicting_max_tokens"},"request_id":"bc2f143d-…"}
{"error":{"message":"Insufficient credits: this request needs up to 2096 units, 0 available. Demo credits are assigned by an administrator.","type":"insufficient_credits","code":"insufficient_credits"},"request_id":"dce7d96d-…"}
{"error":{"message":"Billing database unavailable; request not accepted.","type":"service_unavailable","code":"billing_unavailable"},"request_id":"6130dd33-…"}
```

## Platform (portal) API, `/platform/v1`
Cookie session (`zehnora_session`, HttpOnly) + CSRF header `x-csrf-token` (must equal the `zehnora_csrf` cookie) on every mutation.

| Path | Purpose |
|---|---|
| `POST /auth/register`, `/auth/login`, `/auth/logout`; `GET /session`, `/me` | Accounts (self-registration is always role USER, zero credits; login throttled) |
| `GET/POST /keys`, `POST /keys/{id}/revoke` | Keys (secret returned once at creation) |
| `GET /wallet`, `/usage`, `/models` | Balance/reservations/ledger, request history, catalog with rates |
| `GET/POST /playground/conversations`, `GET/DELETE /playground/conversations/{id}`, `POST …/{id}/messages` | Account-owned playground history (PostgreSQL) |
| `GET /admin/users`, `/admin/users/{id}`, `POST /admin/users/{id}/credits`, `/adjust`, `/status` | Admin (grant with reason; adjust never below reservations; disable revokes keys) |
| `GET /admin/models`, `PATCH /admin/models/{id}`, `POST /admin/models/{id}/rates` | Visibility, availability, versioned rates |
| `GET /admin/requests?state=pending_reconciliation`, `POST /admin/requests/{id}/resolve`, `GET /admin/errors`, `/admin/audit` | Reconciliation and audit |
| `POST /auth/password-reset` | Returns 503 until email delivery is configured (not faked) |
