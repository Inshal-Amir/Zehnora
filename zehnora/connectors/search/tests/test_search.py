"""Search connector tests. Real network: needs internet and the local SearXNG on 127.0.0.1:8888."""
import pytest
from zehnora_search import server as s


def test_real_search_returns_results():
    out = s.web_search("FastAPI SQLite tutorial", 5)
    assert not out.startswith("ERROR"), out
    import json
    data = json.loads(out)
    assert data["results"] and all(r["url"].startswith("http") for r in data["results"])


def test_fetch_real_public_page():
    out = s.fetch_url("https://fastapi.tiangolo.com/tutorial/sql-databases/")
    assert out.startswith("UNTRUSTED WEB CONTENT") and "SQL" in out


@pytest.mark.parametrize("url", ["http://127.0.0.1:8888/", "http://localhost:3090/", "http://169.254.169.254/latest/meta-data/",
                                 "http://10.0.0.1/", "http://192.168.1.1/", "file:///etc/passwd", "http://[::1]/",
                                 "http://user:pw@example.com/", "http://printer.local/"])
def test_private_destinations_blocked(url):
    out = s.fetch_url(url)
    assert out.startswith("ERROR: blocked"), out


def test_redirect_to_private_blocked(monkeypatch):
    # A public URL whose redirect target is private must be refused at the redirect hop.
    import httpx
    real_stream = httpx.Client.stream
    class FakeResp:
        status_code = 302; headers = {"location": "http://127.0.0.1:3090/secret"}
        def __enter__(self): return self
        def __exit__(self, *a): pass
    calls = []
    def fake_stream(self, method, url, **kw):
        calls.append(url)
        return FakeResp()
    monkeypatch.setattr(httpx.Client, "stream", fake_stream)
    out = s.fetch_url("https://example.com/redirect")
    assert out.startswith("ERROR: blocked") and calls == ["https://example.com/redirect"]
