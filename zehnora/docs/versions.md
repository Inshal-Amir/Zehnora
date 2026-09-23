# Versions and environment (recorded 2026-09-22)

## Development Mac (inspected)
| Item | Value |
|---|---|
| Hardware | MacBook Pro 16" (MacBookPro16,1), Intel Core i7-9750H x86_64, 32 GB RAM (not Apple Silicon: no MLX) |
| macOS | 26.6.2 (25G83) |
| Disk free at start | about 41 GB |
| Docker Desktop | 4.45.0 installed but **crashes at startup on this macOS** ("starting electron: unmarshaling start request"). The same crash appears in its logs on 2026-09-18. Mac development therefore uses native processes. |
| Homebrew PostgreSQL | not installable without `sudo chown` on /usr/local/lib/python3.11/site-packages (not done) |

## Repository
| Item | Value |
|---|---|
| Upstream | https://github.com/danny-avila/LibreChat (code base only; no git remote, history not kept) |
| Base | LibreChat **v0.8.7**, commit `9e74cc0e57b395926122bd4062c1fcedc48ed465` (also tested natively on this Mac in the earlier experiment) |
| origin | https://github.com/Inshal-Amir/Zehnora (branch `main`) |

## Mac development stack (pinned)
| Component | Version | Source |
|---|---|---|
| PostgreSQL | 17.5 (zonky embedded-postgres-binaries-darwin-amd64 17.5.0, SHA-1 verified against Maven Central) | .local-dev/tools, loopback :5433, SCRAM auth |
| Python | 3.12.13 (uv-managed) | uv 0.11.28 |
| FastAPI / SQLAlchemy / Alembic / psycopg | 0.141.1 / 2.0.54 / 1.20.0 / 3.3.6 | zehnora/platform-api/uv.lock |
| pwdlib (Argon2id) | 0.3.1 | uv.lock |
| LiteLLM proxy | 1.102.0 + prisma 0.15.0 (Prisma client generated from LiteLLM's schema) | zehnora/infra/litellm/uv.lock |
| Mock inference | local FastAPI app (development only, labelled MOCK) | zehnora/infra/mock-inference |
| Dev model stand-in | Qwen3.5-4B Q4_K_M GGUF (unsloth @ e87f176, SHA-256 00fe7986…11a4) on llama.cpp b9960, CPU | reused from ~/Desktop/LibreChat-Mac-Experiment (no new download) |

**Model rule:** the production model is downloaded only on the university GPU PC. The Mac uses the mock and the existing local 4B only, and neither certifies the GPU deployment.
