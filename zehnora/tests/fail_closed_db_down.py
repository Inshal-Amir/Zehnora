"""Gate A: fail closed when the billing database is unavailable (stops/starts the DEV Postgres only)."""
import json, subprocess, sys, time, uuid, httpx, pathlib
BASE = "http://127.0.0.1:8200"
PGCTL = pathlib.Path.home() / "Desktop/zehnora/.local-dev/tools/postgres-17.5/bin/pg_ctl"
PGDATA = pathlib.Path.home() / "Desktop/zehnora/.local-dev/pgdata"
h = httpx.Client(base_url=BASE, timeout=30)
email = f"failclosed-{uuid.uuid4().hex[:8]}@example.com"
r = h.post("/platform/v1/auth/register", json={"email": email, "password": "fail-closed-pw-1"})
csrf = r.json()["csrf_token"]
key = h.post("/platform/v1/keys", json={"name": "fc"}, headers={"x-csrf-token": csrf}).json()["secret"]
mock_before = pathlib.Path.home().joinpath("Desktop/zehnora/.local-dev/logs/mock.log").read_text().count("POST /v1/chat/completions")
subprocess.run([str(PGCTL), "-D", str(PGDATA), "-m", "fast", "-w", "stop"], check=True, capture_output=True)
try:
    resp = httpx.post(f"{BASE}/v1/chat/completions", headers={"Authorization": f"Bearer {key}"},
                      json={"model": "zehnora-coder", "messages": [{"role": "user", "content": "should not run"}]}, timeout=60)
    print("status:", resp.status_code, json.dumps(resp.json()))
finally:
    subprocess.run([str(PGCTL), "-D", str(PGDATA), "-l", str(PGDATA.parent / "postgres.log"), "-w", "start",
                    "-o", f"-p 5433 -c listen_addresses=127.0.0.1 -k {PGDATA.parent}"], check=True, capture_output=True)
time.sleep(1)
mock_after = pathlib.Path.home().joinpath("Desktop/zehnora/.local-dev/logs/mock.log").read_text().count("POST /v1/chat/completions")
print("mock calls during outage:", mock_after - mock_before)
print("health after restart:", httpx.get(f"{BASE}/platform/v1/health").json())
ok = resp.status_code == 503 and resp.json()["error"]["code"] == "billing_unavailable" and mock_after == mock_before
print("PASS" if ok else "FAIL"); sys.exit(0 if ok else 1)
