# Mac development

Development Mac: MacBook Pro 16" 2019, **Intel** i7-9750H, 32 GB RAM, macOS 26.6.2. Docker Desktop 4.45 crashes at startup on this macOS, so the Mac uses **native processes** everywhere (the GPU PC uses Docker Compose).

## One-time setup (already done on this Mac)
| Item | Where |
|---|---|
| Node 24.16.0 (LibreChat's `.nvmrc`), project-local | `.local-dev/tools/node-v24.16.0-darwin-x64` |
| PostgreSQL 17.5 portable build (zonky, SHA-1 verified), SCRAM auth, loopback :5433 | `.local-dev/tools/postgres-17.5`, data `.local-dev/pgdata` |
| SearXNG (git, pinned commit `019460e`) | `.local-dev/tools/searxng` |
| Playwright Chromium | `.local-dev/playwright-browsers` |
| Secrets (mode 600) | `.local-dev/secrets`, `.local-dev/client/secrets` |
| LibreChat deps + UI build | `npm ci && npm run frontend` at the repo root |
| Python envs | `uv sync` in `zehnora/platform-api`, `infra/litellm`, `infra/mock-inference`, `connectors/*`, `tests` |

`.local-dev/` is git-ignored.

## Everyday commands
```bash
cd ~/Desktop/zehnora
zehnora/scripts/mac/dev-platform.sh start mock           # platform + LiteLLM + MOCK model + portal
zehnora/scripts/mac/dev-platform.sh start dev-local-4b   # same, with the local Qwen3.5-4B (CPU) instead of the mock
zehnora/scripts/mac/dev-platform.sh status | stop
zehnora/scripts/mac/start-desktop.sh                     # Desktop: MongoDB + SearXNG + LibreChat + Electron
zehnora/scripts/mac/start-desktop.sh --services-only
zehnora/scripts/mac/stop-desktop.sh
```
Ports (all 127.0.0.1): PostgreSQL 5433, mock 8101, llama-server 8092, LiteLLM 4000, platform API 8200, portal 5173, LibreChat 3090, client MongoDB 27028, SearXNG 8888, approval bridge 3099.

- Portal: http://127.0.0.1:5173. Dev admin: `.local-dev/secrets/dev-admin-email` and `dev-admin-password`.
- Desktop LibreChat login: `.local-dev/client/secrets/desktop-account.txt`. Its Zehnora key: `.local-dev/client/secrets/zehnora-api-key`.

**Profiles are development only.** `mock` is deterministic (every reply says MOCK); `dev-local-4b` reuses the GGUF from `~/Desktop/LibreChat-Mac-Experiment` and never downloads anything. Neither certifies the GPU deployment.

## Tests (Mac)
```bash
cd zehnora/platform-api && uv run pytest              # Gate A platform suite (needs the mock profile running)
uv run python ../tests/fail_closed_db_down.py         # stops/starts the DEV Postgres
cd ../connectors/workspace && uv run pytest           # workspace connector
cd ../search && uv run pytest                         # search connector (real network)
cd ../../tests && uv run python portal_e2e.py         # portal browser E2E (Playwright)
ZEHNORA_BASE_URL=http://127.0.0.1:8200/v1 ZEHNORA_API_KEY=... uv run python ../scripts/test-public-api.py
cd ../desktop && node tests/electron-e2e.mjs          # Electron shell (Desktop services running)
```
Set `PLAYWRIGHT_BROWSERS_PATH=~/Desktop/zehnora/.local-dev/playwright-browsers` for the Playwright-based tests.
