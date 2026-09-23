"""DEVELOPMENT-ONLY deterministic mock of an OpenAI-compatible chat model.

Every response is visibly labelled "MOCK" and carries the header
`x-roshvyn-mock: true`. It exists to exercise credits, errors and SSE in the
platform without a GPU. Mock success never counts as model success.

Deterministic behaviour:
- prompt_tokens  = total whitespace-separated words in all message contents + 3 per message
- completion text = "MOCK reply to: <first 8 words of last user message>"
- tools present and last message is from the user -> one tool call to the first tool
- last message is a tool result -> text "MOCK final answer after tool: <result>"
- max_tokens / max_completion_tokens truncates the reply (1 word = 1 token)

Test triggers inside the last user message:
  [[mock:error500]]   -> HTTP 500 before any generation
  [[mock:slow]]       -> 0.3 s between streamed words
  [[mock:long]]       -> 200-word reply
  [[mock:midstream]]  -> stream stops after 3 words without a final chunk
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

MODEL_ID = "roshvyn-mock"
HEADERS = {"x-roshvyn-mock": "true"}
app = FastAPI(title="Roshvyn MOCK inference (development only)")


def _text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""


def _prompt_tokens(messages) -> int:
    return sum(len(_text(m.get("content")).split()) + 3 for m in messages)


def _plan(body: dict):
    messages = body.get("messages") or []
    last = messages[-1] if messages else {}
    last_user = next((m for m in reversed(messages) if m.get("role") == "user"), {})
    user_text = _text(last_user.get("content"))
    limit = body.get("max_completion_tokens") or body.get("max_tokens") or 512
    tools = body.get("tools") or []
    if tools and last.get("role") == "user" and body.get("tool_choice") != "none":
        fn = tools[0]["function"]
        props = (fn.get("parameters") or {}).get("properties") or {}
        args = {k: ("mock" if v.get("type", "string") == "string" else 1) for k, v in props.items()}
        return {"tool_call": {"id": "call_mock_" + uuid.uuid4().hex[:12], "name": fn["name"], "arguments": json.dumps(args)}}, user_text
    if last.get("role") == "tool":
        words = ("MOCK final answer after tool: " + _text(last.get("content"))).split()
    elif "[[mock:long]]" in user_text:
        words = ["MOCK"] + [f"word{i}" for i in range(199)]
    else:
        words = ("MOCK reply to: " + " ".join(user_text.split()[:8])).split()
    return {"words": words[: int(limit)], "truncated": len(words) > int(limit)}, user_text


@app.get("/v1/models")
async def models():
    return JSONResponse({"object": "list", "data": [{"id": MODEL_ID, "object": "model", "owned_by": "roshvyn-mock"}]}, headers=HEADERS)


@app.get("/health")
async def health():
    return JSONResponse({"status": "ok", "mock": True}, headers=HEADERS)


@app.post("/v1/chat/completions")
async def chat(request: Request):
    body = await request.json()
    plan, user_text = _plan(body)
    if "[[mock:error500]]" in user_text:
        return JSONResponse({"error": {"message": "MOCK forced upstream error", "type": "server_error"}}, status_code=500, headers=HEADERS)
    cid = "chatcmpl-mock-" + uuid.uuid4().hex[:16]
    created = int(time.time())
    prompt_tokens = _prompt_tokens(body.get("messages") or [])
    model = body.get("model", MODEL_ID)

    if "tool_call" in plan:
        tc = plan["tool_call"]
        completion_tokens = 10
        finish = "tool_calls"
    else:
        completion_tokens = len(plan["words"])
        finish = "length" if plan["truncated"] else "stop"
    usage = {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens, "total_tokens": prompt_tokens + completion_tokens}

    if not body.get("stream"):
        if "tool_call" in plan:
            message = {"role": "assistant", "content": None, "tool_calls": [
                {"id": tc["id"], "type": "function", "function": {"name": tc["name"], "arguments": tc["arguments"]}}]}
        else:
            message = {"role": "assistant", "content": " ".join(plan["words"])}
        return JSONResponse({"id": cid, "object": "chat.completion", "created": created, "model": model,
                             "choices": [{"index": 0, "message": message, "finish_reason": finish}], "usage": usage}, headers=HEADERS)

    include_usage = bool((body.get("stream_options") or {}).get("include_usage"))
    slow = "[[mock:slow]]" in user_text
    midstream = "[[mock:midstream]]" in user_text

    def chunk(delta, finish_reason=None, **extra):
        return "data: " + json.dumps({"id": cid, "object": "chat.completion.chunk", "created": created, "model": model,
                                      "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}], **extra}) + "\n\n"

    async def gen():
        yield chunk({"role": "assistant", "content": ""})
        if "tool_call" in plan:
            yield chunk({"tool_calls": [{"index": 0, "id": tc["id"], "type": "function", "function": {"name": tc["name"], "arguments": ""}}]})
            args = tc["arguments"]
            for i in range(0, len(args), 8):
                yield chunk({"tool_calls": [{"index": 0, "function": {"arguments": args[i:i + 8]}}]})
        else:
            for i, w in enumerate(plan["words"]):
                if midstream and i == 3:
                    return
                if slow:
                    await asyncio.sleep(0.3)
                yield chunk({"content": (" " if i else "") + w})
        yield chunk({}, finish)
        if include_usage:
            yield "data: " + json.dumps({"id": cid, "object": "chat.completion.chunk", "created": created, "model": model,
                                         "choices": [], "usage": usage}) + "\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream", headers=HEADERS)
