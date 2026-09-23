# Zehnora demo script

Part 1 (API platform) and Part 2 (Desktop). On the Mac today it runs in a **development profile**. Say so: "the model here is a development stand-in; the real model runs on the university GPU PC".

## Before the demo
```bash
cd ~/Desktop/zehnora
zehnora/scripts/mac/dev-platform.sh start dev-local-4b    # or: start mock (instant, clearly labelled MOCK)
zehnora/scripts/mac/start-desktop.sh
```
Open http://127.0.0.1:5173 (portal). Keep secrets files off screen.

## Part 1: signup → admin grant → key → SDK call → revoke (about 5 minutes)
1. **Signup:** portal → Create account (new customer). The dashboard shows **0 credits** and "Demo credits are assigned by an administrator."
2. **Admin grant:** in a private window, log in as admin → Users & credits → find the customer → Grant 25 credits with a reason. Show the immutable transaction history.
3. **Key:** customer → API keys → Create key. The secret is shown **once**; afterwards only `sk-…abcd` is listed.
4. **SDK call:** in a terminal:
   ```bash
   export ZEHNORA_BASE_URL=http://127.0.0.1:8200/v1
   export ZEHNORA_API_KEY=<paste the key>
   cd zehnora/tests && uv run python ../scripts/test-public-api.py
   ```
   Show the LangChain `ChatOpenAI` example passing (text, stream, tools).
5. **Usage:** customer dashboard → the requests with exact tokens and charged credits; the balance went down.
6. **Revoke:** API keys → Revoke → run `test-public-api.py --expect-revoked` → 401.
7. Optional: Playground chat (charged to the same wallet, history kept in PostgreSQL).

## Part 2: Zehnora Desktop (about 5 minutes)
1. The Desktop window: the status bar shows the workspace folder and "Model API: online". Log in to the local LibreChat account.
2. Choose the **Zehnora Coder** agent. Prompt: `Create a folder named demo-notes with a README.md that explains what Zehnora is in two sentences, then list the folder.` Show the tool calls, then open the folder in Finder.
3. Approval: ask for something outside the allowlist, e.g. `Run the command: du -sh demo-notes`. The **approval window** appears with the exact command; click Deny (or Approve once).
4. Search: `Search the web for the FastAPI SQLite tutorial and summarise the first result.` (needs internet; the connector reports unavailable engines honestly).
5. Boundary: `Read the file ../../.ssh/config` → refused by the connector (outside the workspace).

## If something is slow or fails
- The Mac 4B stand-in is slow (tens of seconds per step). For a fast walkthrough use `dev-platform.sh start mock` (replies are labelled MOCK) and say so.
- `dev-platform.sh status`, `start-desktop.sh` logs in `.local-dev/client/logs/`.

## After the GPU PC is deployed
Replace `ZEHNORA_BASE_URL` with `https://api.<OWNER_DOMAIN>/v1`, run Part 1 from another internet connection, then start Desktop with `ZEHNORA_API_BASE=https://api.<OWNER_DOMAIN>/v1` and run the ABC full-stack task (Gate E).
