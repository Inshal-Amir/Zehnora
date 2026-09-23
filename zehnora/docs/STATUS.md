# STATUS

Legend: **DONE** = implemented and verified on the stated machine · **IMPLEMENTED** = code/config exists, not yet run where it matters · **BLOCKED** = needs an external prerequisite · **NOT TESTED**

Last update: 2026-09-22, development Mac (Intel i7-9750H, macOS 26.6.2). Repository `~/Desktop/zehnora`, branch `feat/platform` (local only).

## Part A: API platform
| Item | State | Evidence |
|---|---|---|
| Repo from LibreChat v0.8.7 with full upstream history; `zehnora/` namespace; secrets/DBs/models git-ignored | DONE | `git log`, `.gitignore` |
| PostgreSQL (separate `zehnora_platform` / `zehnora_litellm` DBs and roles) | DONE (Mac, native 17.5) | versions.md |
| LiteLLM 1.102.0 gateway with DB; virtual keys: generate / model scope / delete verified | DONE (Mac) | phase-1 spike |
| Accounts, sessions, CSRF, login throttling, admin bootstrap CLI, roles never from signup | DONE | `tests/evidence/gate-a-pytest-mock.txt` |
| API keys shown once, HMAC fingerprint only, revoke (platform immediate + gateway delete), expiry, model scope, orphan compensation | DONE | same |
| Integer wallet, row-locked reservation, idempotent settlement, append-only ledger trigger, adjustments never below reservations | DONE | same |
| `/v1/models`, `/v1/chat/completions` (JSON + SSE, tool calls, OpenAI-style errors + request id) | DONE (mock + local 4B) | same, `sdk-compat-*.txt` |
| Restart recovery + admin reconciliation; client-disconnect drain; fail closed when billing DB down | DONE | gate-a suite, `fail-closed-db-down.txt` |
| **Gate A suite: 27/27** (MOCK profile) | DONE | `tests/evidence/gate-a-pytest-mock.txt` |
| Portal (customer + admin + playground), Playwright browser E2E **12/12** | DONE (mock) | `tests/evidence/portal-e2e-mock.txt`, `evidence/portal/*.png` |
| SDK compatibility (OpenAI SDK + LangChain ChatOpenAI incl. `bind_tools`): **10/10 mock, 10/10 local Qwen3.5-4B** | DONE (dev stand-in) | `sdk-compat-mock.txt`, `sdk-compat-dev-local-4b.txt` |
| Server Compose (postgres, vllm, litellm, platform-api, nginx, cloudflared), Dockerfiles, nginx routing | IMPLEMENTED; `docker compose config` valid; images NOT built (Mac Docker broken) | `infra/server/` |
| Server scripts (init-secrets, download-model, start, stop, health, bootstrap-admin, backup) | IMPLEMENTED; `bash -n` only | `scripts/server/` |
| Gate B (real model on GPU), Gate C (public domain) | BLOCKED: GPU PC access, domain/DNS | `docs/GPU-PC-DEPLOYMENT.md` |

## Part B: Zehnora Desktop
| Item | State | Evidence |
|---|---|---|
| LibreChat client profile (Zehnora API as only model endpoint, customer key in service env only), client MongoDB | DONE (Mac) | `infra/client/librechat.yaml.template` |
| Workspace connector (11 tools, confinement, approval gating, process-tree stop, inspect_page): **14/14 tests** | DONE (Mac) | `connectors/workspace/tests` |
| Real agent run through LibreChat → platform → LiteLLM → local 4B → MCP (create folder + file + list) | DONE 1/1 (dev stand-in) | notes below |
| Search connector (SearXNG + SSRF-safe fetch): **12/12 tests with real network** | DONE (Mac) | `connectors/search/tests` |
| Electron shell (status bar view, isolated chat view, approval window, safeStorage key): **13/13 Playwright Electron checks** | DONE (Mac) | `tests/evidence/desktop-electron-e2e.txt`, `evidence/desktop/*.png` |
| Google Workspace connector (pinned, 19 selected tools, sends/sharing disabled) | IMPLEMENTED; tool list verified; BLOCKED on OAuth client | `docs/GOOGLE-SETUP.md` |
| Windows launcher + preflight | IMPLEMENTED; NOT TESTED (needs Windows) | `scripts/windows/` |
| Document upload / RAG (7.6) | NOT STARTED | KNOWN-LIMITATIONS |
| Gate E: fresh ABC full-stack build by the hosted model | BLOCKED: needs the GPU model | MODEL-EVALUATION |

Notes found during testing (fixed or documented):
- LiteLLM normalises truncated upstream streams (synthetic finish + tokenizer usage) → partial generations billed on delivered usage (CREDITS-AND-RECOVERY.md).
- Electron: text injected into the LibreChat page from a preload froze the renderer under test automation → status bar moved to its own WebContentsView; the chat view now has no preload at all.
- Workspace connector: tightened allowlist (no `python -c`/`node -e`, no `cat`/`uv run`, path arguments must stay inside the workspace); zombie reaping for stopped dev servers.
- My first approval-window test passed through the 120 s auto-deny timeout, not the click; fixed the selector, and the test now requires a click answer in under 30 s.

## Owner actions needed
1. ~~Create the private GitHub repository~~ Done: https://github.com/Inshal-Amir/Zehnora (single `main` branch, fresh history).
2. **At the university GPU PC:** follow `docs/GPU-PC-DEPLOYMENT.md`.
3. **Domain name** and DNS provider access (for the Cloudflare named tunnel).
4. **Google Cloud OAuth client** + demo Google account as test user (`docs/GOOGLE-SETUP.md`).
5. Optional: update/reinstall Docker Desktop on the Mac (it crashes at startup).

## NEXT (unblocked work)
- Document upload/RAG setup and one real document test.
- A labelled dev-profile attempt of the ABC project with the local 4B (evaluation only, not Gate E).
