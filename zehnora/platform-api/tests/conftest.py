"""Integration fixtures: tests talk to the LIVE platform API (default http://127.0.0.1:8200),
which forwards to LiteLLM and the development MOCK model. Evidence label: MOCK profile.

Run: ZEHNORA_TEST_BASE=http://127.0.0.1:8200 uv run pytest -v
"""

from __future__ import annotations

import os
import subprocess
import sys
import uuid
from pathlib import Path

import httpx
import psycopg
import pytest

BASE = os.environ.get("ZEHNORA_TEST_BASE", "http://127.0.0.1:8200")
ROOT = Path(__file__).resolve().parents[1]
PW = "correct-horse-battery-9"


def db_conn():
    from app.config import get_settings

    url = get_settings().database_url.replace("postgresql+psycopg://", "postgresql://")
    return psycopg.connect(url, autocommit=True)


class Portal:
    """A logged-in portal browser session (cookies + CSRF header)."""

    def __init__(self, email: str, password: str = PW, register: bool = True):
        self.email = email
        self.http = httpx.Client(base_url=BASE, timeout=60)
        path = "/platform/v1/auth/register" if register else "/platform/v1/auth/login"
        r = self.http.post(path, json={"email": email, "password": password})
        assert r.status_code in (200, 201), r.text
        self.user = r.json()["user"]
        self.csrf = r.json()["csrf_token"]

    def get(self, path, **kw):
        return self.http.get(path, **kw)

    def post(self, path, json=None, csrf=True, **kw):
        headers = {"x-csrf-token": self.csrf} if csrf else {}
        return self.http.post(path, json=json, headers=headers, **kw)

    def patch(self, path, json=None):
        return self.http.patch(path, json=json, headers={"x-csrf-token": self.csrf})

    def delete(self, path):
        return self.http.delete(path, headers={"x-csrf-token": self.csrf})

    def new_key(self, name="test key"):
        r = self.post("/platform/v1/keys", json={"name": name})
        assert r.status_code == 201, r.text
        return r.json()


def unique_email(tag: str) -> str:
    return f"{tag}-{uuid.uuid4().hex[:10]}@example.com"


@pytest.fixture(scope="session")
def admin(tmp_path_factory) -> Portal:
    email = unique_email("admin")
    pwfile = tmp_path_factory.mktemp("adm") / "pw"
    pwfile.write_text("admin-password-for-tests-1")
    subprocess.run([sys.executable, "-m", "app.cli", "bootstrap-admin", "--email", email, "--password-file", str(pwfile)],
                   cwd=ROOT, check=True, capture_output=True)
    return Portal(email, "admin-password-for-tests-1", register=False)


@pytest.fixture
def user() -> Portal:
    return Portal(unique_email("user"))


def grant(admin: Portal, user: Portal, units: int, reason="test grant"):
    r = admin.post(f"/platform/v1/admin/users/{user.user['id']}/credits", json={"units": units, "reason": reason})
    assert r.status_code == 200, r.text
    return r.json()


def api(key: str, body: dict, stream=False, timeout=60):
    body = {"model": "zehnora-coder", **body}
    if stream:
        body["stream"] = True
    return httpx.post(f"{BASE}/v1/chat/completions", json=body, headers={"Authorization": f"Bearer {key}"}, timeout=timeout)
