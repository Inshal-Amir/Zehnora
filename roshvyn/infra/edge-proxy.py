"""Teaching/edge proxy for the Mac: publishes ONLY the public model API.

On the GPU PC this job is done by nginx (roshvyn/infra/server/nginx/roshvyn.conf.template).
On the Mac we use this tiny equivalent so a phone, another computer, or a temporary
Cloudflare Tunnel can reach the model API without exposing the portal or admin routes.

Allowed:  GET /v1/models, POST /v1/chat/completions, GET /healthz
Blocked:  everything else (/platform/v1/**, admin, anything unknown) -> 404

  uv run --project roshvyn/platform-api python roshvyn/infra/edge-proxy.py            # LAN: 0.0.0.0:8300
  uv run --project roshvyn/platform-api python roshvyn/infra/edge-proxy.py --host 127.0.0.1
"""

from __future__ import annotations

import argparse
import json

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

UPSTREAM = "http://127.0.0.1:8200"
ALLOWED = {("GET", "/v1/models"), ("POST", "/v1/chat/completions")}
app = FastAPI(title="Roshvyn edge proxy", docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/healthz")
async def healthz():
    return {"status": "ok", "proxy": "roshvyn-edge", "allows": ["GET /v1/models", "POST /v1/chat/completions"]}


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
async def forward(path: str, request: Request):
    route = (request.method, "/" + path)
    if route not in ALLOWED:
        return JSONResponse(
            {"error": {"message": "Not found. This address serves only GET /v1/models and POST /v1/chat/completions.",
                       "type": "not_found_error", "code": "not_found"}}, status_code=404)

    # Forward only what the API needs; never pass cookies (portal sessions stay private).
    headers = {k: v for k, v in request.headers.items()
               if k.lower() in ("authorization", "content-type", "accept", "user-agent")}
    body = await request.body()
    client = httpx.AsyncClient(timeout=httpx.Timeout(900.0, connect=10))
    req = client.build_request(request.method, f"{UPSTREAM}/{path}", headers=headers, content=body)
    upstream = await client.send(req, stream=True)
    out_headers = {k: v for k, v in upstream.headers.items()
                   if k.lower() in ("content-type", "x-request-id", "cache-control")}

    if "text/event-stream" in upstream.headers.get("content-type", ""):
        async def stream():
            try:
                async for chunk in upstream.aiter_raw():
                    yield chunk
            finally:
                await upstream.aclose()
                await client.aclose()
        return StreamingResponse(stream(), status_code=upstream.status_code, media_type="text/event-stream", headers=out_headers)

    data = await upstream.aread()
    await upstream.aclose()
    await client.aclose()
    return JSONResponse(json.loads(data) if data else {}, status_code=upstream.status_code, headers=out_headers)


if __name__ == "__main__":
    import uvicorn

    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0", help="0.0.0.0 = reachable from your network; 127.0.0.1 = this Mac only")
    ap.add_argument("--port", type=int, default=8300)
    a = ap.parse_args()
    print(f"Roshvyn edge proxy on {a.host}:{a.port} -> {UPSTREAM} (only /v1/models and /v1/chat/completions)")
    uvicorn.run(app, host=a.host, port=a.port, log_level="info")
