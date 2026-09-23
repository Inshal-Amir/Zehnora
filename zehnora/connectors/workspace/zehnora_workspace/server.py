"""Zehnora workspace MCP server (runs on the client machine; never exposed publicly).

Tools: list_directory, read_file, write_file, apply_patch, create_directory, move_path,
run_command, start_project, project_status, stop_project, inspect_page.
"""

from __future__ import annotations

import difflib
import json
import os
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from mcp.server.fastmcp import FastMCP

from . import commands
from .paths import FILE_LIKE_SUFFIXES, ToolError, refuse_hidden, rel, resolve, workspace_root

MAX_READ_BYTES = 512 * 1024
MAX_WRITE_BYTES = 1024 * 1024
MAX_OUTPUT_CHARS = 8000
MAX_RETRIES = 2
RETRY_WINDOW_S = 600

mcp = FastMCP("zehnora-workspace")
_failures: dict[str, tuple[int, float]] = {}


def _log(tool: str, args: dict, ok: bool, result: str) -> None:
    shown = {k: (v if not isinstance(v, str) or len(v) <= 300 else v[:300] + f"…[{len(v)} chars]") for k, v in args.items()}
    entry = {"ts": datetime.now(timezone.utc).astimezone().isoformat(timespec="milliseconds"), "tool": tool,
             "workspace": str(_safe_root()), "args": shown, "ok": ok, "result": result[:600]}
    with (commands.data_dir() / "tool-executions.jsonl").open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")


def _safe_root():
    try:
        return workspace_root()
    except Exception:
        return None


def _clip(text: str) -> str:
    return text if len(text) <= MAX_OUTPUT_CHARS else text[:MAX_OUTPUT_CHARS] + f"\n…[truncated: {len(text)} characters total]"


def _run(tool: str, args: dict, fn) -> str:
    key = tool + json.dumps(args, sort_keys=True)
    count, last = _failures.get(key, (0, 0.0))
    if count > MAX_RETRIES and time.monotonic() - last < RETRY_WINDOW_S:
        msg = f"ERROR: retry limit reached - this exact call already failed {count} times. Change the approach or report the problem."
        _log(tool, args, False, msg)
        return msg
    try:
        result = fn()
        text = result if isinstance(result, str) else json.dumps(result, indent=1, ensure_ascii=False)
        _failures.pop(key, None)
        _log(tool, args, True, text)
        return _clip(text)
    except ToolError as exc:
        msg = f"ERROR: {exc}"
    except Exception as exc:  # never crash the server
        msg = f"ERROR: {type(exc).__name__}: {exc}"
    _failures[key] = (count + 1, time.monotonic())
    _log(tool, args, False, msg)
    return msg


def _backup(target: Path, root: Path) -> str:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    dest = commands.data_dir() / "backups" / root.name / f"{rel(target, root)}.{stamp}.bak"
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(target, dest)
    return str(dest)


def _write(target: Path, data: bytes) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    fd = os.open(target, flags, 0o644)
    with os.fdopen(fd, "wb") as fh:
        fh.write(data)


@mcp.tool()
def list_directory(relative_path: str = ".") -> str:
    """List files and folders in a workspace directory ("." is the workspace root)."""
    def run():
        target, root = resolve(relative_path, must_exist=True)
        if not target.is_dir():
            raise ToolError(f"not a directory: {relative_path}")
        skip = {"node_modules", ".venv", "__pycache__", ".git"}
        entries = sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        lines = []
        for e in entries[:300]:
            if e.is_symlink():
                lines.append(f"[LINK] {e.name}")
            elif e.is_dir():
                lines.append(f"[DIR]  {e.name}/" + ("  (dependencies, not listed)" if e.name in skip else ""))
            else:
                lines.append(f"[FILE] {e.name} ({e.stat().st_size} bytes)")
        return f"{rel(target, root)} in workspace {root}:\n" + ("\n".join(lines) or "(empty)")
    return _run("list_directory", {"relative_path": relative_path}, run)


@mcp.tool()
def read_file(relative_path: str) -> str:
    """Read a UTF-8 text file from the workspace. Returns the raw file content."""
    def run():
        target, _ = resolve(relative_path, must_exist=True)
        if not target.is_file():
            raise ToolError(f"not a file: {relative_path}")
        if target.stat().st_size > MAX_READ_BYTES:
            raise ToolError(f"file too large to read ({target.stat().st_size} bytes; limit {MAX_READ_BYTES})")
        text = target.read_text(encoding="utf-8", errors="replace")
        return text if text else "(file is empty)"
    return _run("read_file", {"relative_path": relative_path}, run)


@mcp.tool()
def write_file(relative_path: str, content: str) -> str:
    """Create or overwrite a text file with the full content. Missing folders are created; an existing file is backed up."""
    def run():
        data = content.encode("utf-8")
        if len(data) > MAX_WRITE_BYTES:
            raise ToolError(f"content too large ({len(data)} bytes; limit {MAX_WRITE_BYTES})")
        refuse_hidden(relative_path)
        target, root = resolve(relative_path)
        if target == root or target.is_dir():
            raise ToolError(f"a folder exists at {relative_path}; choose a file path")
        note = f" (previous version backed up)" if target.exists() else ""
        if target.exists():
            _backup(target, root)
        _write(target, data)
        return f"OK: wrote {len(data)} bytes to {rel(target, root)}{note}"
    return _run("write_file", {"relative_path": relative_path, "content": content}, run)


@mcp.tool()
def apply_patch(relative_path: str, old_text: str, new_text: str) -> str:
    """Edit a file by replacing one exact occurrence of old_text with new_text (read the file first).
    old_text must match exactly once. The previous version is backed up and a diff is returned."""
    def run():
        target, root = resolve(relative_path, must_exist=True)
        if not target.is_file():
            raise ToolError(f"not a file: {relative_path}")
        original = target.read_text(encoding="utf-8")
        count = original.count(old_text) if old_text else 0
        if count != 1:
            raise ToolError(f"old_text must match exactly once; it matched {count} times. Read the file and copy the exact text.")
        updated = original.replace(old_text, new_text, 1)
        _backup(target, root)
        _write(target, updated.encode("utf-8"))
        diff = "".join(difflib.unified_diff(original.splitlines(True), updated.splitlines(True),
                                            fromfile=f"a/{rel(target, root)}", tofile=f"b/{rel(target, root)}", n=2))
        return f"OK: patched {rel(target, root)}\n{diff}"
    return _run("apply_patch", {"relative_path": relative_path, "old_text": old_text, "new_text": new_text}, run)


@mcp.tool()
def create_directory(relative_path: str) -> str:
    """Create a folder (and missing parents) in the workspace."""
    def run():
        refuse_hidden(relative_path)
        target, root = resolve(relative_path)
        if target.suffix.lower() in FILE_LIKE_SUFFIXES and not target.is_dir():
            raise ToolError(f"'{target.name}' looks like a file name; use write_file (it creates folders automatically)")
        if target.exists() and not target.is_dir():
            raise ToolError(f"a file already exists at {relative_path}")
        existed = target.is_dir()
        target.mkdir(parents=True, exist_ok=True)
        return f"OK: directory {rel(target, root)} {'already existed' if existed else 'created'}"
    return _run("create_directory", {"relative_path": relative_path}, run)


@mcp.tool()
def move_path(source_relative_path: str, destination_relative_path: str) -> str:
    """Move or rename a file or folder inside the workspace. Fails if the destination exists."""
    def run():
        src, root = resolve(source_relative_path, must_exist=True)
        if src == root:
            raise ToolError("cannot move the workspace root")
        refuse_hidden(destination_relative_path)
        dst, _ = resolve(destination_relative_path)
        if dst.exists():
            raise ToolError(f"destination already exists: {destination_relative_path}")
        dst.parent.mkdir(parents=True, exist_ok=True)
        os.rename(src, dst)
        return f"OK: moved {rel(src, root)} to {rel(dst, root)}"
    return _run("move_path", {"source_relative_path": source_relative_path, "destination_relative_path": destination_relative_path}, run)


@mcp.tool()
def run_command(command: str, cwd: str = ".", timeout_s: int = 60, shell: str = "auto") -> str:
    """Run a command in the workspace and wait for it. Build/test commands (npm, node, python, uv, pip, pytest, git status...)
    run directly; anything else asks the user for approval first. timeout_s: default 60, up to 900 for installs.
    On Windows, shell may be 'powershell' or 'cmd'. Returns shell, exit code, duration and truncated output."""
    return _run("run_command", {"command": command, "cwd": cwd, "timeout_s": timeout_s, "shell": shell},
                lambda: commands.run_command(command, cwd, timeout_s, shell))


@mcp.tool()
def start_project(name: str, command: str, cwd: str = ".", port: int | None = None, wait_s: int = 60) -> str:
    """Start a long-running process such as a dev server (e.g. 'npm run dev' or 'uvicorn main:app --port 8000').
    If port is given, waits until it accepts connections. Returns a project_id for project_status/stop_project."""
    return _run("start_project", {"name": name, "command": command, "cwd": cwd, "port": port, "wait_s": wait_s},
                lambda: commands.start_project(name, command, cwd, port, wait_s))


@mcp.tool()
def project_status(project_id: str | None = None) -> str:
    """Show running projects started by this connector, their ports and recent log lines."""
    return _run("project_status", {"project_id": project_id}, lambda: commands.project_status(project_id))


@mcp.tool()
def stop_project(project_id: str) -> str:
    """Stop a project started with start_project (only its own process tree is stopped)."""
    return _run("stop_project", {"project_id": project_id}, lambda: commands.stop_project(project_id))


@mcp.tool()
def inspect_page(url: str, screenshot_name: str = "preview") -> str:
    """Open a local web page (localhost/127.0.0.1 only) in a headless browser. Returns the title, visible text excerpt,
    console errors and failed requests, and saves a screenshot in the workspace folder 'previews/'."""
    def run():
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https") or parsed.hostname not in ("localhost", "127.0.0.1"):
            raise ToolError("inspect_page only opens local previews (http://localhost:<port> or http://127.0.0.1:<port>)")
        from playwright.sync_api import sync_playwright

        root = workspace_root()
        safe = "".join(c for c in screenshot_name if c.isalnum() or c in "-_")[:40] or "preview"
        shot = root / "previews" / f"{safe}-{datetime.now().strftime('%H%M%S')}.png"
        shot.parent.mkdir(exist_ok=True)
        errors, failed = [], []
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={"width": 1200, "height": 800})
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("requestfailed", lambda r: failed.append(f"{r.method} {r.url}"))
            page.on("response", lambda r: failed.append(f"HTTP {r.status} {r.url}") if r.status >= 400 else None)
            page.goto(url, wait_until="networkidle", timeout=30000)
            title = page.title()
            text = page.inner_text("body")[:1500]
            page.screenshot(path=str(shot), full_page=True)
            browser.close()
        return {"url": url, "title": title, "visible_text": text, "console_errors": errors[:20],
                "failed_requests": failed[:20], "screenshot": rel(shot, root),
                "verdict": "no blocking errors seen" if not errors and not failed else "errors found - inspect and fix"}
    return _run("inspect_page", {"url": url, "screenshot_name": screenshot_name}, run)


def main() -> None:
    print(f"zehnora-workspace MCP serving {workspace_root()}", file=sys.stderr)
    mcp.run()


if __name__ == "__main__":
    main()
