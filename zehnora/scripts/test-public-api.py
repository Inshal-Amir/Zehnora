"""Public API compatibility check with ordinary SDK clients.

Usage (keys come from the environment, never from source):
  export ZEHNORA_BASE_URL=https://api.<OWNER_DOMAIN>/v1      # or http://127.0.0.1:8200/v1 in development
  export ZEHNORA_API_KEY=<customer key>
  uv run --project zehnora/tests python zehnora/scripts/test-public-api.py
  uv run --project zehnora/tests python zehnora/scripts/test-public-api.py --expect-revoked   # after revoking the key
  ... test-public-api.py --no-thinking   # thinking models (Qwen3.6): the short max_tokens budgets below assume no thinking

Checks: /v1/models, OpenAI SDK text / stream / tools / tool-result continuation,
LangChain ChatOpenAI invoke / stream / bind_tools, OpenAI-style error for a bad key.
Prints PASS/FAIL per check and exits non-zero on any failure. Reports whether the
upstream was the development MOCK (header x-zehnora-mock) so mock runs are never
mistaken for model results.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

import httpx

RESULTS: list[tuple[str, bool, str]] = []
MODEL = os.environ.get("ZEHNORA_MODEL", "zehnora-coder")
TOOLS = [{
    "type": "function",
    "function": {
        "name": "get_task_count",
        "description": "Return how many tasks exist in a project.",
        "parameters": {"type": "object", "properties": {"project": {"type": "string", "description": "Project name"}},
                       "required": ["project"]},
    },
}]


def check(name: str, fn):
    t0 = time.monotonic()
    try:
        detail = fn() or ""
        RESULTS.append((name, True, detail))
        print(f"[PASS] {name} ({time.monotonic() - t0:.1f}s) {detail}")
    except Exception as exc:  # report every failure, keep going
        RESULTS.append((name, False, f"{type(exc).__name__}: {exc}"))
        print(f"[FAIL] {name} ({time.monotonic() - t0:.1f}s) {type(exc).__name__}: {str(exc)[:300]}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--expect-revoked", action="store_true", help="verify the key is now rejected (401)")
    ap.add_argument("--skip-langchain", action="store_true")
    ap.add_argument("--no-thinking", action="store_true",
                    help="send chat_template_kwargs.enable_thinking=false (Qwen thinking models)")
    args = ap.parse_args()
    base = os.environ["ZEHNORA_BASE_URL"].rstrip("/")
    key = os.environ["ZEHNORA_API_KEY"]
    if base.endswith("/chat/completions"):
        sys.exit("ZEHNORA_BASE_URL must end at /v1, without /chat/completions")
    headers = {"Authorization": f"Bearer {key}"}
    extra = {"chat_template_kwargs": {"enable_thinking": False}} if args.no_thinking else {}

    if args.expect_revoked:
        def revoked():
            r = httpx.post(f"{base}/chat/completions", headers=headers, timeout=60,
                           json={"model": MODEL, "messages": [{"role": "user", "content": "x"}]})
            assert r.status_code == 401, f"expected 401, got {r.status_code}: {r.text[:200]}"
            return r.json()["error"]["code"]
        check("revoked key is rejected with 401", revoked)
        return summary()

    from openai import OpenAI

    client = OpenAI(base_url=base, api_key=key, timeout=600, max_retries=0)

    def models():
        ids = [m.id for m in client.models.list().data]
        assert MODEL in ids, ids
        return f"models={ids}"
    check("GET /v1/models lists the alias", models)

    def upstream_kind():
        r = httpx.post(f"{base}/chat/completions", headers=headers, timeout=600,
                       json={"model": MODEL, "messages": [{"role": "user", "content": "Reply with the word ready."}], "max_tokens": 16, **extra})
        r.raise_for_status()
        mock = r.headers.get("x-zehnora-mock") == "true" or r.json()["choices"][0]["message"].get("content", "").startswith("MOCK")
        return f"upstream={'MOCK (development only)' if mock else 'model'} request_id={r.headers.get('x-request-id')}"
    check("identify upstream (mock vs model)", upstream_kind)

    def text():
        r = client.chat.completions.create(model=MODEL, max_tokens=200, extra_body=extra, messages=[
            {"role": "user", "content": "Write a Python function that validates a non-empty task title. Reply with code only."}])
        content = r.choices[0].message.content or ""
        assert content.strip(), "empty content"
        assert r.usage and r.usage.prompt_tokens > 0 and r.usage.completion_tokens > 0, r.usage
        return f"{len(content)} chars, usage {r.usage.prompt_tokens}/{r.usage.completion_tokens}"
    check("OpenAI SDK: text completion", text)

    def stream():
        parts, finish = [], None
        for chunk in client.chat.completions.create(model=MODEL, stream=True, max_tokens=80, extra_body=extra,
                                                    messages=[{"role": "user", "content": "Count from 1 to 5."}]):
            if chunk.choices:
                parts.append(chunk.choices[0].delta.content or "")
                finish = chunk.choices[0].finish_reason or finish
        assert "".join(parts).strip(), "no streamed content"
        assert finish is not None, "stream had no finish_reason"
        return f"{len(parts)} chunks, finish={finish}"
    check("OpenAI SDK: streaming", stream)

    def tools():
        msgs = [{"role": "system", "content": "Use the provided tools when they can answer the question."},
                {"role": "user", "content": "How many tasks are in the project named alpha? Use the tool."}]
        r = client.chat.completions.create(model=MODEL, messages=msgs, tools=TOOLS, tool_choice="auto", max_tokens=200, extra_body=extra)
        tc = (r.choices[0].message.tool_calls or [None])[0]
        assert tc is not None, f"no tool call; content={r.choices[0].message.content!r}"
        args_ = json.loads(tc.function.arguments)
        assert tc.function.name == "get_task_count" and isinstance(args_.get("project"), str), (tc.function.name, args_)
        msgs += [{"role": "assistant", "content": r.choices[0].message.content, "tool_calls": [tc.model_dump()]},
                 {"role": "tool", "tool_call_id": tc.id, "content": json.dumps({"project": args_["project"], "count": 7})}]
        final = client.chat.completions.create(model=MODEL, messages=msgs, tools=TOOLS, max_tokens=200, extra_body=extra)
        content = final.choices[0].message.content or ""
        assert "7" in content, f"final answer does not use the tool result: {content!r}"
        return f"call id {tc.id[:14]}…, args {args_}, final mentions 7"
    check("OpenAI SDK: automatic tool call + tool-result continuation", tools)

    def stream_tools():
        name, arg_text, ids = "", "", set()
        for chunk in client.chat.completions.create(model=MODEL, stream=True, tools=TOOLS, max_tokens=200, extra_body=extra, messages=[
                {"role": "user", "content": "Use the tool to count tasks in project beta."}]):
            for d in (chunk.choices[0].delta.tool_calls or []) if chunk.choices else []:
                if d.id:
                    ids.add(d.id)
                if d.function:
                    name += d.function.name or ""
                    arg_text += d.function.arguments or ""
        assert name == "get_task_count" and len(ids) == 1, (name, ids)
        return f"args {json.loads(arg_text)}"
    check("OpenAI SDK: streamed tool call assembly", stream_tools)

    if not args.skip_langchain:
        from langchain_openai import ChatOpenAI

        llm = ChatOpenAI(model=MODEL, base_url=base, api_key=key, use_responses_api=False, max_retries=0, timeout=600,
                         extra_body=extra or None)

        def lc_invoke():
            response = llm.invoke("Write a Python function that validates a non-empty task title.")
            assert response.content, "empty"
            return f"{len(response.content)} chars"
        check("LangChain ChatOpenAI.invoke (brief 6.7 example)", lc_invoke)

        def lc_stream():
            chunks = [c.content for c in llm.stream("Say hello in three words.")]
            assert "".join(chunks).strip()
            return f"{len(chunks)} chunks"
        check("LangChain ChatOpenAI.stream", lc_stream)

        def lc_tools():
            from langchain_core.tools import tool

            @tool
            def get_task_count(project: str) -> int:
                """Return how many tasks exist in a project."""
                return 7

            msg = llm.bind_tools([get_task_count]).invoke("How many tasks are in project gamma? Use the tool.")
            assert msg.tool_calls and msg.tool_calls[0]["name"] == "get_task_count", msg
            return f"tool_calls={msg.tool_calls[0]['args']}"
        check("LangChain ChatOpenAI.bind_tools", lc_tools)

    def bad_key():
        r = httpx.post(f"{base}/chat/completions", headers={"Authorization": "Bearer sk-invalid-key"}, timeout=30,
                       json={"model": MODEL, "messages": [{"role": "user", "content": "x"}]})
        body = r.json()
        assert r.status_code == 401 and body["error"]["code"] and body.get("request_id"), (r.status_code, body)
        return body["error"]["code"]
    check("invalid key -> 401 OpenAI-style error with request_id", bad_key)
    return summary()


def summary() -> int:
    passed = sum(ok for _, ok, _ in RESULTS)
    print(f"\n{passed}/{len(RESULTS)} checks passed")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
