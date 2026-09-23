"""Workspace connector tests (native Mac). Windows PowerShell/CMD paths need a separate run on Windows."""
import json, os, socket, sys, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import pytest


@pytest.fixture()
def ws(tmp_path, monkeypatch):
    root = tmp_path / "Roshvyn-Workspace"; root.mkdir()
    outside = tmp_path / "outside"; outside.mkdir(); (outside / "secret.txt").write_text("OUTSIDE-SECRET")
    monkeypatch.setenv("ROSHVYN_WORKSPACE", str(root))
    monkeypatch.setenv("ROSHVYN_CONNECTOR_DATA", str(tmp_path / "data"))
    monkeypatch.delenv("ROSHVYN_APPROVAL_URL", raising=False)
    from roshvyn_workspace import server
    server._failures.clear()
    return server, root, outside


def test_file_tools_and_patch(ws):
    s, root, _ = ws
    assert s.create_directory("abc/src").startswith("OK")
    assert s.write_file("abc/src/app.py", "x = 1\nprint(x)\n").startswith("OK")
    assert s.read_file("abc/src/app.py") == "x = 1\nprint(x)\n"
    out = s.apply_patch("abc/src/app.py", "x = 1", "x = 2")
    assert out.startswith("OK") and "-x = 1" in out and "+x = 2" in out
    assert (root / "abc/src/app.py").read_text() == "x = 2\nprint(x)\n"
    assert "matched 0 times" in s.apply_patch("abc/src/app.py", "nope", "y")
    assert s.move_path("abc/src/app.py", "abc/main.py").startswith("OK")
    assert "[FILE] main.py" in s.list_directory("abc")


@pytest.mark.parametrize("bad", ["../outside/secret.txt", "/etc/hosts", "~/.zshrc", "a/../../outside/secret.txt"])
def test_escapes_rejected(ws, bad):
    s, _, _ = ws
    out = s.read_file(bad)
    assert out.startswith("ERROR") and "OUTSIDE-SECRET" not in out


def test_symlink_escape(ws):
    s, root, outside = ws
    os.symlink(outside, root / "link")
    assert s.read_file("link/secret.txt").startswith("ERROR")
    assert s.write_file("link/new.txt", "x").startswith("ERROR")
    assert not (outside / "new.txt").exists()


def test_hidden_and_filelike_names(ws):
    s, _, _ = ws
    assert "leading dot" in s.create_directory(".hidden")
    assert "looks like a file" in s.create_directory("site/index.html")


def test_policy_classification(ws):
    from roshvyn_workspace.commands import classify
    _, root, outside = ws
    ok = lambda c: classify(c, root, root)[1] is None
    assert ok("npm install") and ok("npm run build") and ok("python -m pytest -q") and ok("python app.py") and ok("pytest")
    assert not ok("python -c 'import os'") and not ok("node -e 'x'") and not ok("rm -rf build")
    assert not ok("npm install && rm -rf /") and not ok("git push origin main") and not ok("uv run anything")
    assert not ok(f"python {outside}/evil.py") and not ok("cat ../outside/secret.txt") and not ok("curl http://example.com")
    assert not ok("python") and not ok("python -m http_evil")


def test_run_command_autonomous_and_env_scrubbed(ws, monkeypatch):
    s, root, _ = ws
    monkeypatch.setenv("ROSHVYN_API_KEY", "sk-must-not-leak")
    (root / "show_env.py").write_text("import os,sys; print(sys.version_info[0]); print('LEAK' if 'ROSHVYN_API_KEY' in os.environ else 'CLEAN')")
    out = json.loads(s.run_command(f"{Path(sys.executable).name} show_env.py"))
    assert out["exit_code"] == 0 and "CLEAN" in out["stdout"] and out["shell"] == "direct (no shell)"
    assert out["cwd"] == "." and out["duration_s"] >= 0


def test_run_command_needs_approval_without_ui(ws):
    s, _, _ = ws
    out = s.run_command("rm -rf somewhere")
    assert out.startswith("ERROR") and "approval" in out


class _Approver(BaseHTTPRequestHandler):
    decision = True
    seen = []
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        ok_auth = self.headers.get("authorization") == "Bearer s3cret"
        _Approver.seen.append((body, ok_auth))
        self.send_response(200 if ok_auth else 401); self.end_headers()
        self.wfile.write(json.dumps({"approved": _Approver.decision and ok_auth}).encode())
    def log_message(self, *a): pass


def test_approval_bridge_approve_and_deny(ws, tmp_path, monkeypatch):
    s, root, _ = ws
    srv = HTTPServer(("127.0.0.1", 0), _Approver); threading.Thread(target=srv.serve_forever, daemon=True).start()
    (tmp_path / "secret").write_text("s3cret")
    monkeypatch.setenv("ROSHVYN_APPROVAL_URL", f"http://127.0.0.1:{srv.server_port}/approve")
    monkeypatch.setenv("ROSHVYN_APPROVAL_SECRET_FILE", str(tmp_path / "secret"))
    (root / "f.txt").write_text("hello")
    _Approver.decision = True
    out = json.loads(s.run_command("wc -c f.txt"))
    assert out["approved_by_user"] is True and "5" in out["stdout"] and _Approver.seen[-1][0]["command"] == "wc -c f.txt"
    _Approver.decision = False
    denied = s.run_command("wc -l f.txt")
    assert denied.startswith("ERROR") and "denied" in denied
    (tmp_path / "secret").write_text("wrong")
    assert s.run_command("wc -w f.txt").startswith("ERROR")
    srv.shutdown()


def _free_port():
    with socket.socket() as so:
        so.bind(("127.0.0.1", 0)); return so.getsockname()[1]


def test_start_status_stop_kills_process_tree(ws):
    s, root, _ = ws
    port = _free_port()
    (root / "srv.py").write_text(
        "import subprocess, sys, http.server, socketserver\n"
        "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(600)'])\n"  # grandchild in the same group
        f"socketserver.TCPServer(('127.0.0.1', {port}), http.server.SimpleHTTPRequestHandler).serve_forever()\n")
    started = json.loads(s.start_project("demo", f"{Path(sys.executable).name} srv.py", ".", port, 20))
    assert started["running"] and started["port_ready"]
    status = json.loads(s.project_status(started["project_id"]))["projects"][0]
    assert status["running"] and status["port_open"]
    stopped = json.loads(s.stop_project(started["project_id"]))
    assert stopped["stopped"] and not stopped["still_running"] and stopped["port_free"]
    time.sleep(0.5)
    import subprocess as sp
    leftovers = sp.run(["pgrep", "-f", "time.sleep\\(600\\)"], capture_output=True, text=True).stdout.strip()
    assert leftovers == "", f"grandchild survived: {leftovers}"
    assert s.stop_project(started["project_id"]).startswith("ERROR")


def test_inspect_page_local_only_and_reports_errors(ws):
    s, root, _ = ws
    port = _free_port()
    (root / "site").mkdir()
    (root / "site/index.html").write_text("<html><head><title>T</title></head><body><h1>Hello</h1><script>console.error('boom')</script></body></html>")
    started = json.loads(s.start_project("site", f"{Path(sys.executable).name} -m http.server {port}", "site", port, 20))
    try:
        out = json.loads(s.inspect_page(f"http://127.0.0.1:{port}/index.html", "t"))
        assert out["title"] == "T" and "Hello" in out["visible_text"] and any("boom" in e for e in out["console_errors"])
        assert (root / out["screenshot"]).exists()
    finally:
        s.stop_project(started["project_id"])
    assert s.inspect_page("https://example.com").startswith("ERROR")


def test_retry_limit(ws):
    s, _, _ = ws
    outs = [s.read_file("missing.txt") for _ in range(4)]
    assert "retry limit" in outs[3]
