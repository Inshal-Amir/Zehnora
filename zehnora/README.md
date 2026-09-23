# Zehnora (on top of LibreChat)

Everything Zehnora-specific lives in this folder; LibreChat's upstream layout at the repository root is unchanged.

| Folder | What |
|---|---|
| `platform-api/` | FastAPI platform: accounts, keys, credit wallet, `/v1` API, admin (PostgreSQL, Alembic) |
| `portal/` | Customer/admin console (React + TypeScript + Vite) |
| `desktop/` | Electron shell around the local LibreChat UI (status bar, approval window) |
| `connectors/workspace/` | Files, commands, dev servers, page inspection (MCP) |
| `connectors/search/` | SearXNG search + safe page fetch (MCP) |
| `connectors/google/` | Pinned Google Workspace MCP connector configuration |
| `infra/` | LiteLLM profiles, mock model, client LibreChat config, server Compose (vLLM, nginx, tunnel) |
| `scripts/mac`, `scripts/server`, `scripts/windows` | Start/stop/health/deploy scripts |
| `tests/` | End-to-end tests and evidence |
| `brand/` | Product name, colours, strings |
| `docs/` | Start with `STATUS.md`, then `ARCHITECTURE.md`, `MAC-DEVELOPMENT.md`, `GPU-PC-DEPLOYMENT.md` |
