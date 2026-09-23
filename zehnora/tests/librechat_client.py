"""Client for a Zehnora Desktop LibreChat instance: the same agent chat routes the UI uses.

login -> POST /api/auth/login ; agent -> POST/PATCH /api/agents ;
chat  -> POST /api/agents/chat/agents then SSE GET /api/agents/chat/stream/<id>
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CLIENT = REPO / ".local-dev" / "client"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
NO_PARENT = "00000000-0000-0000-0000-000000000000"
SERVER = "zehnora-workspace"
TOOLS = [f"{t}_mcp_{SERVER}" for t in ("list_directory", "read_file", "write_file", "apply_patch", "create_directory", "move_path",
                                       "run_command", "start_project", "project_status", "stop_project", "inspect_page")]
AGENT_NAME = "Zehnora Coder"
INSTRUCTIONS = """You are Zehnora Coder, a coding assistant working inside the user's selected workspace folder.
Use the tools to do real work: create and edit files, run commands, start and check dev servers.
Never claim something works unless a tool result shows it.
Read a file before editing it; use apply_patch for small edits and write_file for new files.
Use relative paths inside the workspace.
Verify your work: run build/test commands, and after starting a web app use inspect_page on it.
If a tool fails, read the error and make a bounded fix. If you cannot finish, state the exact blocker."""


class LibreChat:
    def __init__(self, base: str = "http://127.0.0.1:3090", account_file: Path = CLIENT / "secrets" / "desktop-account.txt"):
        self.base = base
        acct = account_file.read_text()
        email = re.search(r"Email: (.*)", acct).group(1).strip()
        password = re.search(r"Password: (.*)", acct).group(1).strip()
        self.token = None
        self.token = self._req("POST", "/api/auth/login", {"email": email, "password": password})["token"]

    def _req(self, method, path, body=None, timeout=60):
        headers = {"Content-Type": "application/json", "User-Agent": UA}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(self.base + path, method=method, data=data, headers=headers)
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return json.load(resp)

    def ensure_agent(self, recursion_limit: int = 25, max_context: int = 7000, max_tokens: int = 1024) -> str:
        cache = CLIENT / "run" / "agent-id.txt"
        body = {"name": AGENT_NAME, "instructions": INSTRUCTIONS, "tools": TOOLS, "recursion_limit": recursion_limit,
                "model_parameters": {"maxContextTokens": max_context, "max_tokens": max_tokens}}
        if cache.exists():
            try:
                self._req("PATCH", f"/api/agents/{cache.read_text().strip()}", body)
                return cache.read_text().strip()
            except urllib.error.HTTPError:
                pass
        agent = self._req("POST", "/api/agents", {**body, "description": "Zehnora coding agent with workspace tools",
                                                   "provider": "Zehnora", "model": "zehnora-coder"})
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(agent["id"])
        return agent["id"]

    def chat(self, agent_id: str, text: str, conversation_id=None, parent_id=None, deadline_s: int = 1800) -> dict:
        body = {"text": text, "sender": "User", "isCreatedByUser": True, "parentMessageId": parent_id or NO_PARENT,
                "messageId": str(uuid.uuid4()), "conversationId": conversation_id, "endpoint": "agents", "agent_id": agent_id,
                "isTemporary": False, "isRegenerate": False, "isContinued": False}
        t0 = time.time()
        started = self._req("POST", "/api/agents/chat/agents", body)
        req = urllib.request.Request(f"{self.base}/api/agents/chat/stream/{started['streamId']}",
                                     headers={"Authorization": "Bearer " + self.token, "User-Agent": UA})
        final, n = None, 0
        with urllib.request.urlopen(req, timeout=deadline_s) as resp:
            for raw in resp:
                line = raw.decode("utf-8", "replace").rstrip("\n")
                if line.startswith("data: "):
                    n += 1
                    try:
                        data = json.loads(line[6:])
                    except json.JSONDecodeError:
                        continue
                    if isinstance(data, dict) and data.get("final"):
                        final = data
                        break
                if time.time() - t0 > deadline_s:
                    break
        response = (final or {}).get("responseMessage") or {}
        texts, calls = [], []
        for part in response.get("content") or []:
            if part.get("type") == "text":
                texts.append(part.get("text") or "")
            elif part.get("type") == "tool_call":
                tc = part.get("tool_call") or {}
                calls.append({"name": (tc.get("name") or "").split("_mcp_")[0], "args": tc.get("args"), "output": (tc.get("output") or "")[:400]})
            elif part.get("type") == "error":
                texts.append(f"[error part] {part.get('error') or part}")
        return {"conversationId": started["conversationId"], "responseMessageId": response.get("messageId"),
                "text": "".join(texts).strip() or response.get("text", ""), "tool_calls": calls,
                "error": None if final else "no final event", "elapsed_s": round(time.time() - t0, 1), "events": n}
