# Zehnora Desktop

Electron app (Mac and Windows) with its own UI and agent runtime, connected to the Zehnora model API (`https://api.dubg.dev/v1`, model `zehnora-coder`). No LibreChat, MongoDB or Python needed on the client.

## Two modes

| | Chat | Work |
|---|---|---|
| Purpose | Questions, writing, research | Doing things on the computer |
| Tools | `web_search`, `fetch_url` (public internet only), `github_search`, `github_repo`, `current_time` | Everything in Chat plus files (`read_file`, `write_file`, `edit_file`, `list_directory`, `find_files`, `search_text`, `create_directory`, `move_path`, `delete_path`), shell (`run_command`), background processes (`start_process`, `process_output`, `stop_process`, `list_processes`), `system_info`, `open`, `check_web_page` |
| Step limit | 8 model rounds | 60 model rounds (then "continue") |
| Folder | none | per-task working folder (default `~/Zehnora`) |

Git, GitHub (`gh`), Docker, databases and package managers are used through `run_command` / `start_process` with the user's login-shell `PATH`.

## Agent runtime (`src/main/agent`)

`runtime.ts` loop: build messages within the context budget (`context.ts`: shorten old tool output first, then drop oldest steps, keep the task) → stream `/chat/completions` with tool schemas (`llm.ts`: SSE, `reasoning_content` or `<think>` tags, tool-call deltas, retry only before any output) → run each tool call → feed results back → repeat until the model answers without tools. Stop cancels the stream and kills the running process tree. Identical failing calls are refused after two failures.

## Approvals (`src/main/tools/policy.ts`, `agent/approvals.ts`)

Every tool call is rated `safe`, `normal` or `risky`:
- **safe** – reading, listing, searching, `git status/log/diff`, `docker ps/logs`, version checks.
- **normal** – changes inside the working folder, project installs (`npm install`, `pip install`), builds, `git add/commit/clone`, `docker run`, `docker compose up`.
- **risky** – deleting, `git push`, `reset --hard`, `sudo`, system/global installs, `curl | sh`, command substitution, destructive SQL, killing processes, writing outside the working folder, reading secrets (`~/.ssh`, `.env` elsewhere, the app's own data), unknown programs.

Settings → approval policy: ask for risky (default), ask for every change, or never ask. The approval card appears inline in the thread: Allow / Always allow in this chat (keyed by every program in the command line) / Deny. Deletions go to the Trash; overwritten files are backed up to `<userData>/backups`.

## Data

`<userData>` = `~/Library/Application Support/Zehnora` (Mac) or `%APPDATA%\Zehnora` (Windows): `settings.json`, `secrets/*.bin` (API key and GitHub token encrypted with the OS keychain via `safeStorage`), `conversations/*.json`, `backups/`, `screenshots/`.

## Develop

```bash
cd zehnora/desktop
npm install
npm start            # build + run
npm run typecheck
npm test             # vitest: policy, LLM client, runtime loop with a mock model, tools
npm run e2e          # real Electron app against tests/mock-model.mjs (Playwright), screenshots in zehnora/tests/evidence/desktop
npm run dist:mac     # release/*.dmg   (dist:win for the Windows installer, build it on Windows)
```

Environment overrides (tests): `ZEHNORA_USER_DATA`, `ZEHNORA_API_BASE`, `ZEHNORA_API_KEY`, `ZEHNORA_MODEL`, `ZEHNORA_GITHUB_TOKEN`.

Web search runs SearXNG when an address is set in Settings, otherwise DuckDuckGo and then Bing in a hidden, sandboxed Chromium window (plain HTTP requests get bot-checked).
