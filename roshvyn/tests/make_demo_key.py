"""Create a fresh customer with admin-granted credits and print a new API key (development helper)."""
import sys, uuid, httpx
from pathlib import Path
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8200"
CREDITS = float(sys.argv[2]) if len(sys.argv) > 2 else 200
S = Path.home() / "Desktop/roshvyn/.local-dev/secrets"
cust = httpx.Client(base_url=BASE, timeout=30)
email = f"sdk-{uuid.uuid4().hex[:8]}@example.com"
r = cust.post("/platform/v1/auth/register", json={"email": email, "password": "sdk-test-password-1"}); r.raise_for_status()
cust_csrf, uid = r.json()["csrf_token"], r.json()["user"]["id"]
adm = httpx.Client(base_url=BASE, timeout=30)
a = adm.post("/platform/v1/auth/login", json={"email": (S / "dev-admin-email").read_text().strip(), "password": (S / "dev-admin-password").read_text().strip()}); a.raise_for_status()
adm.post(f"/platform/v1/admin/users/{uid}/credits", json={"credits": CREDITS, "reason": "SDK compatibility test"},
         headers={"x-csrf-token": a.json()["csrf_token"]}).raise_for_status()
k = cust.post("/platform/v1/keys", json={"name": "sdk test"}, headers={"x-csrf-token": cust_csrf}); k.raise_for_status()
print(k.json()["secret"])
print(f"customer {email}, key id {k.json()['key']['id']}", file=sys.stderr)
