"""Portal browser end-to-end (Playwright, headless Chromium) against the running dev stack.

Flow: customer signs up (0 credits) -> admin grants credits in the admin UI -> customer creates a
key (shown once) -> real API call with the key -> usage visible -> playground reply -> revoke ->
the next API call fails. Upstream model in the Mac dev profile is the labelled MOCK (or local 4B).

Screenshots go to zehnora/tests/evidence/portal/ and never show a live key secret.
"""

from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

import httpx
from playwright.sync_api import expect, sync_playwright

PORTAL = os.environ.get("ZEHNORA_PORTAL", "http://127.0.0.1:5173")
SECRETS = Path.home() / "Desktop/zehnora/.local-dev/secrets"
OUT = Path(__file__).parent / "evidence" / "portal"
OUT.mkdir(parents=True, exist_ok=True)
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = ""):
    results.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name} {detail}")


def main() -> int:
    email = f"customer-{uuid.uuid4().hex[:8]}@example.com"
    password = "customer-pass-" + uuid.uuid4().hex[:8]
    admin_email = (SECRETS / "dev-admin-email").read_text().strip()
    admin_pw = (SECRETS / "dev-admin-password").read_text().strip()
    console_errors: list[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        cust = browser.new_context(viewport={"width": 1280, "height": 860})
        page = cust.new_page()
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)

        # 1. Customer registers
        page.goto(PORTAL + "/register")
        page.get_by_label("Email").fill(email)
        page.get_by_label("Password").fill(password)
        page.get_by_role("button", name="Create account").click()
        expect(page.get_by_role("heading", name="Dashboard")).to_be_visible()
        expect(page.get_by_text("You have no credits yet")).to_be_visible()
        check("customer registered, dashboard shows zero credits", True)
        page.screenshot(path=str(OUT / "01-dashboard-zero-credits.png"))

        # 2. Admin grants credits through the admin UI (separate browser context)
        adm_ctx = browser.new_context(viewport={"width": 1280, "height": 860})
        adm = adm_ctx.new_page()
        adm.goto(PORTAL + "/")
        adm.get_by_label("Email").fill(admin_email)
        adm.get_by_label("Password").fill(admin_pw)
        adm.get_by_role("button", name="Sign in").click()
        adm.get_by_role("link", name="Users & credits").click()
        adm.get_by_placeholder("Search by email").fill(email)
        adm.get_by_role("button", name="Search").click()
        adm.get_by_role("link", name=email).click()
        adm.get_by_label("Credits", exact=True).fill("25")
        adm.get_by_label("Reason (recorded permanently)").fill("Portal E2E demo grant")
        adm.get_by_role("button", name="Grant", exact=True).click()
        expect(adm.get_by_text("Granted 25 credits.")).to_be_visible()
        expect(adm.get_by_role("cell", name="Portal E2E demo grant")).to_be_visible()
        check("admin granted 25 credits via UI with reason in immutable history", True)
        adm.screenshot(path=str(OUT / "02-admin-grant.png"))

        # 3. Customer sees credits and creates a key (secret shown once)
        page.reload()
        expect(page.locator(".stat .value").first).to_have_text("25")
        check("customer dashboard shows 25 available credits", True)
        page.get_by_role("link", name="API keys").click()
        page.get_by_label("Key name").fill("e2e laptop")
        page.get_by_role("button", name="Create key").click()
        secret = page.locator(".secret-value").inner_text().strip()
        check("key secret displayed once", secret.startswith("sk-"), f"prefix {secret[:6]}…")
        page.get_by_role("button", name="I have stored it").click()
        expect(page.locator(".secret-value")).to_have_count(0)
        listed = page.locator("table code").first.inner_text()
        check("key list shows only a masked form", secret not in listed and listed.endswith(secret[-4:]), listed)
        page.screenshot(path=str(OUT / "03-keys-masked.png"))

        # 4. Real API call with that key through the public /v1 path
        api_base = PORTAL + "/v1"
        r = httpx.post(f"{api_base}/chat/completions", headers={"Authorization": f"Bearer {secret}"},
                       json={"model": "zehnora-coder", "messages": [{"role": "user", "content": "hello from the portal e2e"}]}, timeout=120)
        check("API call with portal-created key succeeds", r.status_code == 200, f"HTTP {r.status_code}")
        is_mock = r.headers.get("x-zehnora-mock") == "true" or "MOCK" in r.text
        print("   upstream:", "MOCK (development profile)" if is_mock else "non-mock model")

        # 5. Usage visible on the dashboard
        page.get_by_role("link", name="Dashboard").click()
        expect(page.get_by_role("cell", name="settled").first).to_be_visible()
        avail = float(page.locator(".stat .value").first.inner_text().replace(",", ""))
        check("dashboard shows the settled request and reduced balance", avail < 25, f"available {avail}")
        page.screenshot(path=str(OUT / "04-dashboard-usage.png"))

        # 6. Playground (session path, same wallet)
        page.get_by_role("link", name="Playground").click()
        page.get_by_placeholder("Message zehnora-coder").fill("playground e2e hello")
        page.get_by_role("button", name="Send").click()
        reply = page.locator(".msg.assistant .bubble").first
        expect(reply).not_to_have_text("Thinking…", timeout=120_000)
        check("playground reply received and stored", len(reply.inner_text()) > 0, reply.inner_text()[:60])
        page.reload()
        expect(page.locator(".msg.assistant .bubble").first).to_be_visible()
        check("playground history persists after reload", True)
        page.screenshot(path=str(OUT / "05-playground.png"))

        # 7. Revoke key -> next API call fails
        page.get_by_role("link", name="API keys").click()
        page.once("dialog", lambda d: d.accept())
        page.get_by_role("button", name="Revoke").click()
        expect(page.get_by_text("revoked").first).to_be_visible()
        r2 = httpx.post(f"{api_base}/chat/completions", headers={"Authorization": f"Bearer {secret}"},
                        json={"model": "zehnora-coder", "messages": [{"role": "user", "content": "after revoke"}]}, timeout=60)
        check("request with revoked key fails with 401", r2.status_code == 401, f"HTTP {r2.status_code}")
        page.screenshot(path=str(OUT / "06-key-revoked.png"))

        # 8. Customer cannot open admin pages
        page.goto(PORTAL + "/admin/users")
        expect(page.get_by_role("heading", name="Dashboard")).to_be_visible()
        check("non-admin is redirected away from admin pages", True)
        browser.close()

    check("no browser console errors", not console_errors, "; ".join(console_errors[:3]))
    passed = sum(ok for _, ok, _ in results)
    print(f"\n{passed}/{len(results)} checks passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
