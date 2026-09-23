"""Command execution policy, native shells and tracked long-running projects.

Policy (brief 7.3):
- Recognised build/test commands run autonomously, without a shell, with cwd inside the workspace.
- Everything else (unknown programs, shell operators, git push, deletes...) needs an explicit user
  approval from Roshvyn Desktop's approval dialog (loopback bridge + per-install secret). With no
  approval UI connected, such commands are refused.
- Child processes get a scrubbed environment (no Roshvyn/LiteLLM/cloud credentials).
- This is NOT a sandbox: approved programs run with the user's permissions.
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import signal
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

import httpx

from .paths import ToolError, rel, resolve

IS_WIN = sys.platform == "win32"
MAX_OUT = 4000
DEFAULT_TIMEOUT = 60
MAX_TIMEOUT = 900
SHELL_META = set("|&;<>`$(){}\n")
SECRET_ENV_PREFIXES = ("ROSHVYN_", "LITELLM_", "OPENAI_", "ANTHROPIC_", "AWS_", "AZURE_", "GOOGLE_", "GH_", "GITHUB_",
                       "HF_", "HUGGING", "CLOUDFLARE", "DATABASE_URL", "MONGO", "CREDS_", "JWT_", "LLAMA_API_KEY")

# Allowed autonomously: program -> allowed first arguments (None = checked separately below).
AUTONOMOUS = {
    "npm": {"install", "i", "ci", "run", "test", "start", "init", "create", "ls", "--version", "-v"},
    "npx": {"--yes", "-y", "create-vite", "vite", "tsc", "eslint"},
    "node": None, "python": None, "python3": None, "py": None,
    "pip": {"install", "list", "show", "freeze", "--version"}, "pip3": {"install", "list", "show", "freeze", "--version"},
    "uv": {"venv", "pip", "sync", "add", "init", "lock", "--version"},
    "pytest": None, "uvicorn": None, "vite": None, "tsc": None,
    "git": {"init", "status", "diff", "log", "add", "commit", "branch", "show", "--version"},
}
# `python -m <module>` modules allowed without approval.
PY_MODULES = {"pip", "venv", "pytest", "uvicorn", "http.server", "py_compile", "unittest", "compileall", "json.tool"}
INLINE_CODE_FLAGS = {"-c", "-e", "--eval", "-p", "--print", "--input-type"}


def data_dir() -> Path:
    d = Path(os.environ.get("ROSHVYN_CONNECTOR_DATA", Path.home() / ".roshvyn" / "workspace-connector"))
    (d / "projects").mkdir(parents=True, exist_ok=True)
    return d


def safe_env() -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(SECRET_ENV_PREFIXES)}
    env.setdefault("PYTHONUNBUFFERED", "1")
    env["CI"] = "1"  # non-interactive tool behaviour (npm create etc.)
    return env


def detect_shell(requested: str) -> tuple[str, list[str] | None]:
    """Return (shell name, argv prefix or None for direct exec)."""
    requested = (requested or "auto").lower()
    if IS_WIN:
        if requested in ("powershell", "pwsh", "auto"):
            exe = shutil.which("pwsh") or shutil.which("powershell") or "powershell.exe"
            return ("powershell", [exe, "-NoProfile", "-NonInteractive", "-Command"])
        if requested == "cmd":
            return ("cmd", [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/s", "/c"])
        raise ToolError("On Windows use shell 'powershell' or 'cmd'.")
    if requested in ("powershell", "pwsh", "cmd"):
        raise ToolError(f"{requested} is not available on this Mac; commands run with the user's shell.")
    user_shell = os.environ.get("SHELL") or "/bin/zsh"
    return (Path(user_shell).name, [user_shell, "-lc"])


def _paths_inside(args: list[str], cwd: Path, root: Path) -> str | None:
    """Every argument that looks like a filesystem path must stay inside the workspace."""
    from .paths import inside
    for a in args:
        value = a.split("=", 1)[1] if a.startswith("-") and "=" in a else a
        if value.startswith("-") or not value:
            continue
        looks_like_path = "/" in value or "\\" in value or value.startswith(("~", ".")) or (len(value) > 1 and value[1] == ":")
        if not looks_like_path:
            continue
        if value.startswith(("http://", "https://")):
            continue
        target = Path(os.path.realpath((cwd / Path(value).expanduser()) if not os.path.isabs(os.path.expanduser(value)) else Path(value).expanduser()))
        if not inside(target, root):
            return f"argument {value!r} points outside the workspace"
    return None


def classify(command: str, cwd: Path | None = None, root: Path | None = None) -> tuple[list[str] | None, str | None]:
    """Return (argv, None) if autonomously allowed, else (argv or None, reason approval is needed)."""
    if any(ch in SHELL_META for ch in command):
        return None, "uses shell operators"
    try:
        argv = shlex.split(command, posix=not IS_WIN)
    except ValueError as exc:
        return None, f"could not parse command ({exc})"
    if not argv:
        raise ToolError("empty command")
    prog = Path(argv[0]).name.lower().removesuffix(".exe").removesuffix(".cmd")
    if prog not in AUTONOMOUS:
        return argv, f"'{prog}' is not in the autonomous build/test allowlist"
    allowed = AUTONOMOUS[prog]
    if allowed is not None and (len(argv) < 2 or argv[1] not in allowed):
        return argv, f"'{prog} {argv[1] if len(argv) > 1 else ''}' is not an allowed subcommand"
    if prog == "git" and any(a in ("push", "reset", "clean", "remote", "config") for a in argv[1:]):
        return argv, "git operation that changes remote or destroys history"
    if prog in ("python", "python3", "py", "node"):
        if any(a in INLINE_CODE_FLAGS for a in argv[1:]):
            return argv, "runs inline code"
        if prog != "node" and "-m" in argv:
            i = argv.index("-m")
            module = argv[i + 1] if i + 1 < len(argv) else ""
            if module not in PY_MODULES:
                return argv, f"'python -m {module}' is not an allowed module"
        else:
            script = next((a for a in argv[1:] if not a.startswith("-")), None)
            if script is None:
                return argv, "interactive interpreter"
    if cwd is not None and root is not None:
        outside = _paths_inside(argv[1:], cwd, root)
        if outside:
            return argv, outside
    return argv, None


def request_approval(command: str, cwd: str, shell: str, reason: str) -> bool:
    url = os.environ.get("ROSHVYN_APPROVAL_URL")
    secret_file = os.environ.get("ROSHVYN_APPROVAL_SECRET_FILE")
    if not url or not secret_file:
        raise ToolError(f"This command needs user approval ({reason}), but no Roshvyn Desktop approval window is connected. "
                        "Ask the user to run it themselves or use an allowed build/test command.")
    try:
        secret = Path(secret_file).read_text().strip()
        r = httpx.post(url, json={"command": command, "cwd": cwd, "shell": shell, "reason": reason},
                       headers={"Authorization": f"Bearer {secret}"}, timeout=180)
    except (OSError, httpx.HTTPError) as exc:
        raise ToolError(f"approval window unreachable ({type(exc).__name__}); command not run") from exc
    if r.status_code != 200:
        raise ToolError(f"approval bridge refused the request (HTTP {r.status_code}); command not run")
    return bool(r.json().get("approved"))


def _clip(text: str) -> str:
    return text if len(text) <= MAX_OUT else text[:MAX_OUT // 2] + f"\n…[{len(text) - MAX_OUT} characters omitted]…\n" + text[-MAX_OUT // 2:]


def _popen_kwargs() -> dict:
    if IS_WIN:
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


def kill_tree(pid: int) -> None:
    if IS_WIN:
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)
        return
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    for _ in range(30):
        _reap(pid)
        try:
            os.killpg(pid, 0)
        except (ProcessLookupError, PermissionError):
            # macOS answers EPERM when only zombies remain in the group: nothing alive to stop.
            return
        time.sleep(0.1)
    try:
        os.killpg(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    _reap(pid)


_children: dict[int, subprocess.Popen] = {}


def _reap(pid: int) -> None:
    proc = _children.get(pid)
    if proc is not None and proc.poll() is not None:
        _children.pop(pid, None)


def prepare(command: str, cwd: str, shell: str) -> tuple[list[str], Path, Path, str, bool]:
    """Policy check (and approval if needed). Returns (argv, cwd path, root, shell name, approved)."""
    cwd_path, root = resolve(cwd or ".", must_exist=True)
    if not cwd_path.is_dir():
        raise ToolError(f"cwd is not a directory: {cwd}")
    shell_name, prefix = detect_shell(shell)
    argv, reason = classify(command, cwd_path, root)
    approved = False
    if reason is not None:
        if not request_approval(command, rel(cwd_path, root), shell_name, reason):
            raise ToolError("The user denied this command. Do not retry it; explain what you wanted to do instead.")
        approved = True
    if IS_WIN or argv is None or reason is not None:
        run_argv = [*prefix, command]  # explicit native shell
    else:
        exe = shutil.which(argv[0], path=safe_env().get("PATH")) or argv[0]
        run_argv = [exe, *argv[1:]]
        shell_name = "direct (no shell)"
    return run_argv, cwd_path, root, shell_name, approved


def run_command(command: str, cwd: str = ".", timeout_s: int = DEFAULT_TIMEOUT, shell: str = "auto") -> dict:
    timeout_s = max(1, min(int(timeout_s or DEFAULT_TIMEOUT), MAX_TIMEOUT))
    run_argv, cwd_path, root, shell_name, approved = prepare(command, cwd, shell)
    t0 = time.monotonic()
    proc = subprocess.Popen(run_argv, cwd=cwd_path, env=safe_env(), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            stdin=subprocess.DEVNULL, text=True, encoding="utf-8", errors="replace", **_popen_kwargs())
    try:
        out, err = proc.communicate(timeout=timeout_s)
        timed_out = False
    except subprocess.TimeoutExpired:
        kill_tree(proc.pid)
        out, err = proc.communicate()
        timed_out = True
    return {"shell": shell_name, "command": command, "cwd": rel(cwd_path, root), "exit_code": proc.returncode,
            "timed_out": timed_out, "duration_s": round(time.monotonic() - t0, 2), "approved_by_user": approved,
            "stdout": _clip(out or ""), "stderr": _clip(err or "")}


# ---------------- long-running projects (dev servers) ----------------

@dataclass
class Project:
    id: str
    name: str
    command: str
    cwd: str
    pid: int
    log: str
    started: float
    port: int | None


def _state_file() -> Path:
    return data_dir() / "projects.json"


def _load() -> dict[str, dict]:
    try:
        return json.loads(_state_file().read_text())
    except (OSError, ValueError):
        return {}


def _save(state: dict[str, dict]) -> None:
    _state_file().write_text(json.dumps(state, indent=1))


def _alive(pid: int) -> bool:
    _reap(pid)
    if pid in _children:
        return _children[pid].poll() is None
    if IS_WIN:
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True).stdout
        return str(pid) in out
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _port_open(port: int) -> bool:
    import socket
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def _tail(path: str, n: int = 40) -> str:
    try:
        lines = Path(path).read_text(errors="replace").splitlines()
    except OSError:
        return ""
    return _clip("\n".join(lines[-n:]))


def start_project(name: str, command: str, cwd: str = ".", port: int | None = None, wait_s: int = 60, shell: str = "auto") -> dict:
    run_argv, cwd_path, root, shell_name, approved = prepare(command, cwd, shell)
    if port and _port_open(port):
        raise ToolError(f"port {port} is already in use; choose another port or stop the other project first")
    pid_log = data_dir() / "projects" / f"{uuid.uuid4().hex[:8]}.log"
    log = open(pid_log, "w")
    proc = subprocess.Popen(run_argv, cwd=cwd_path, env=safe_env(), stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                            **_popen_kwargs())
    pid = proc.pid
    _children[pid] = proc  # keep the handle so the exited process can be reaped (no zombies)
    project = Project(id=pid_log.stem, name=name, command=command, cwd=rel(cwd_path, root), pid=pid, log=str(pid_log),
                      started=time.time(), port=port)
    state = _load()
    state[project.id] = project.__dict__
    _save(state)
    ready = None
    if port:
        deadline = time.monotonic() + max(1, min(wait_s, 300))
        while time.monotonic() < deadline and proc.poll() is None:
            if _port_open(port):
                ready = True
                break
            time.sleep(0.5)
        ready = bool(ready)
    else:
        time.sleep(2)
    return {"project_id": project.id, "name": name, "pid": pid, "shell": shell_name, "cwd": project.cwd, "port": port,
            "running": proc.poll() is None, "port_ready": ready, "approved_by_user": approved, "log_tail": _tail(project.log)}


def project_status(project_id: str | None = None) -> dict:
    state = _load()
    items = [state[project_id]] if project_id else list(state.values())
    if project_id and project_id not in state:
        raise ToolError(f"unknown project id {project_id}")
    return {"projects": [{"project_id": p["id"], "name": p["name"], "command": p["command"], "cwd": p["cwd"], "pid": p["pid"],
                          "running": _alive(p["pid"]), "port": p["port"],
                          "port_open": _port_open(p["port"]) if p["port"] else None,
                          "log_tail": _tail(p["log"], 25)} for p in items]}


def _matches(p: dict) -> bool:
    """Guard against PID reuse: the live process must still look like the command we started."""
    first = Path(shlex.split(p["command"], posix=not IS_WIN)[0]).name.lower() if p["command"].strip() else ""
    if IS_WIN:
        out = subprocess.run(["tasklist", "/FI", f"PID eq {p['pid']}", "/FO", "CSV", "/NH"], capture_output=True, text=True).stdout.lower()
        return bool(out.strip()) and (first.split(".")[0] in out or "powershell" in out or "cmd.exe" in out or "node" in out or "python" in out)
    out = subprocess.run(["ps", "-p", str(p["pid"]), "-o", "command="], capture_output=True, text=True).stdout.lower()
    return bool(out.strip()) and (first in out or "sh -lc" in out)


def stop_project(project_id: str) -> dict:
    state = _load()
    p = state.get(project_id)
    if not p:
        raise ToolError(f"unknown project id {project_id} (only projects started by this connector can be stopped)")
    was_running = _alive(p["pid"]) and _matches(p)
    if was_running:
        kill_tree(p["pid"])  # the process group created for this run only
    state.pop(project_id)
    _save(state)
    return {"project_id": project_id, "stopped": was_running, "still_running": _alive(p["pid"]),
            "port_free": (not _port_open(p["port"])) if p["port"] else None}
