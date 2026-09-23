# Third-party notices (Zehnora additions)

Zehnora is built on **LibreChat** (https://github.com/danny-avila/LibreChat, v0.8.7, MIT License, © LibreChat contributors). LibreChat's license and notices at the repository root are kept unchanged. Rebranding does not grant access to any features beyond those in the open-source release.

Zehnora code under `zehnora/` uses these third-party components (versions pinned in the lock files):

| Component | Use | License |
|---|---|---|
| LiteLLM 1.102.0 (+ Prisma client 0.15.0) | internal model gateway, virtual keys | MIT (open-source edition; enterprise features not used) |
| vLLM v0.29.0 (Docker image) | GPU inference on the server | Apache-2.0 |
| FastAPI, Starlette, Pydantic, SQLAlchemy, Alembic, psycopg, httpx, uvicorn | platform API | MIT / BSD / LGPL-3.0 (psycopg, dynamically used) |
| pwdlib + argon2-cffi | password hashing | MIT |
| Model Context Protocol Python SDK 1.30.0 | connectors | MIT |
| Playwright 1.58 | page inspection and tests | Apache-2.0 |
| Beautiful Soup 4 | page text extraction | MIT |
| SearXNG (git 019460e) | local web search | AGPL-3.0 (run as a separate local service, unmodified) |
| workspace-mcp 1.27.1 (taylorwilsdon/google_workspace_mcp) | Google Workspace connector | MIT |
| React 19, React Router 7, Vite 8, TypeScript 5.9 | portal | MIT / Apache-2.0 |
| Electron 44, electron-builder 26 | desktop shell | MIT |
| PostgreSQL 17 | databases | PostgreSQL License |
| MongoDB Community Server | LibreChat storage (client) | SSPL (used unmodified, locally) |
| nginx 1.29, cloudflared 2026.9 | ingress | BSD-2 / Apache-2.0 |
| Qwen models (Qwen3-4B-Instruct-2507, Qwen3.5-4B) | model weights (downloaded on the GPU PC, not in Git) | Apache-2.0 (see each model card) |
