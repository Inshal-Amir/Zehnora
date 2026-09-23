# Zehnora on the university GPU PC (step by step)

This guide deploys the **server profile**: vLLM + the real model, LiteLLM, PostgreSQL, the platform API, the portal, nginx and (last) the Cloudflare Tunnel. It is written for the known target (Ryzen 7 9700X, 64 GB RAM, RTX 4070 Ti SUPER 16 GB), but **inspect the real hardware first** (step 1).

Every command block says where it runs:
- **PowerShell** = Windows PowerShell on the GPU PC
- **WSL** = the Ubuntu (WSL2) terminal on the GPU PC

> **Status:** these steps were written and syntax-checked on the development Mac. They have **not been run on the GPU PC yet**. Record the real output of each step in `zehnora/docs/STATUS.md`.

**Model rule:** the model is downloaded **only here**, on the GPU PC, never on the Mac.

---

## 0. What you need before starting
- Admin rights on the PC (for installing drivers, WSL and Docker Desktop, if missing).
- The private GitHub repository URL and a way to log in to GitHub (browser or a personal token typed at the prompt; **never put a token inside the clone URL**).
- About 60 GB free on a fast SSD (model about 8–10 GB, images about 15 GB, database and backups).
- Later, for public access: your domain name and access to its DNS (step 10).
- The PC must stay **on, awake and online** while it hosts the API.

## 1. Preflight: inspect the PC (no changes)
**PowerShell** (from the folder where you will clone, or after step 2):
```powershell
powershell -ExecutionPolicy Bypass -File zehnora\scripts\windows\Preflight.ps1 -GpuContainerTest
```
It checks Windows, RAM, disk, the NVIDIA driver (`nvidia-smi`), WSL2, Docker Desktop, GPU inside a container, port 8080 and sleep settings, and saves `preflight-result.json`. Fix any `CHECK` rows first:
- **NVIDIA driver**: install the current Windows driver from NVIDIA. Do **not** install Linux display drivers inside WSL; WSL uses the Windows driver.
- **WSL2**: `wsl --install -d Ubuntu-24.04` (PowerShell as admin), then reboot.
- **Docker Desktop**: install it, then Settings → General → "Use the WSL 2 based engine", and Settings → Resources → WSL integration → enable Ubuntu.
- **GPU in container** must print the RTX card. If it fails, update Docker Desktop and the NVIDIA driver.

## 2. Get the code (inside WSL, on the Linux filesystem)
**WSL**:
```bash
sudo apt-get update && sudo apt-get install -y git curl openssl python3
curl -LsSf https://astral.sh/uv/install.sh | sh    # uv (for the model download)
cd ~ && git clone https://github.com/Inshal-Amir/Zehnora.git zehnora
cd ~/zehnora
```
Keep the repository in `~/zehnora` (Linux filesystem), not under `/mnt/c`, for speed.

## 3. Create the server secrets
**WSL**:
```bash
cd ~/zehnora && zehnora/scripts/server/init-secrets.sh
nano .server-secrets/server.env      # set OWNER_DOMAIN and ZEHNORA_MODEL_DIR (e.g. /home/<you>/zehnora-models)
```
`.server-secrets/` is git-ignored and mode 600. Never copy secrets or databases from the Mac.

## 4. Check the tool-call parser for the pinned vLLM (do not guess)
**WSL**:
```bash
docker run --rm vllm/vllm-openai:v0.29.0 --help | grep -A6 -- '--tool-call-parser'
```
- Baseline `Qwen/Qwen3-4B-Instruct-2507`: expected parser `hermes`.
- Challenger `Qwen/Qwen3.5-4B`: the model card uses `qwen3_coder`; also check the flag that disables image/video inputs (text-only).

Put the verified value in `ZEHNORA_TOOL_PARSER` in `server.env`.

## 5. Download the model (pinned revision, outside Git)
**WSL**:
```bash
cd ~/zehnora && zehnora/scripts/server/download-model.sh
```
Uses `ZEHNORA_MODEL_REPO` + `ZEHNORA_MODEL_REVISION` (full commit sha) from `server.env`, writes `SHA256SUMS` and `ZEHNORA-PROVENANCE.txt` next to the weights. Record both in `docs/MODEL-EVALUATION.md`.

## 6. Build the portal
**WSL** (Node 24 via nvm or the official tarball):
```bash
cd ~/zehnora/zehnora/portal && npm ci && npm run build
```

## 7. Start the services (local only, no tunnel yet)
**WSL**:
```bash
cd ~/zehnora && zehnora/scripts/server/start.sh
zehnora/scripts/server/health.sh
```
`start.sh` builds the LiteLLM and platform images, starts PostgreSQL and vLLM, waits for health (the model load takes a few minutes), then LiteLLM, the platform API and nginx (`127.0.0.1:8080` only). It prints the model deployment identity and GPU memory.

## 8. One-time platform setup
**WSL**:
```bash
# first administrator (password prompted, not logged)
zehnora/scripts/server/bootstrap-admin.sh admin@<OWNER_DOMAIN>
# model catalog entry shown to customers (tested context/output limits)
docker exec zehnora-platform-api-1 python -m app.cli seed-model --alias zehnora-coder \
  --identity "Qwen/Qwen3-4B-Instruct-2507 @ cdbee75 BF16, vLLM v0.29.0, RTX 4070 Ti SUPER" --context 4096 --max-output 1024
# restricted gateway key for the portal playground -> add to .server-secrets/platform.env, then restart
docker exec zehnora-platform-api-1 python -m app.cli create-gateway-key
nano .server-secrets/platform.env    # ZEHNORA_PLAYGROUND_GATEWAY_KEY=<printed key>; ZEHNORA_PUBLIC_API_BASE=https://api.<OWNER_DOMAIN>/v1
docker compose -f zehnora/infra/server/compose.yaml --env-file .server-secrets/server.env up -d platform-api
```

## 9. Gate B: test locally BEFORE exposing anything
**WSL**:
```bash
curl -s -H "Host: api.<OWNER_DOMAIN>" http://127.0.0.1:8080/v1/models          # expect 401 (no key)
```
Then in a browser on the PC, open `http://127.0.0.1:8080` with the Host header set. The simplest way is to add `127.0.0.1 console.<OWNER_DOMAIN> api.<OWNER_DOMAIN>` to `C:\Windows\System32\drivers\etc\hosts` **temporarily**. Then:
1. Register a customer, grant credits as admin, create a key.
2. **WSL**: `ZEHNORA_BASE_URL=http://api.<OWNER_DOMAIN>:8080/v1 ZEHNORA_API_KEY=<key> uv run --project zehnora/tests python zehnora/scripts/test-public-api.py`
3. Record the results, the GPU memory (`nvidia-smi`) and the timings in `MODEL-EVALUATION.md`. Remove the hosts entries afterwards.

## 10. Public HTTPS with a named Cloudflare Tunnel
1. Confirm where the domain's DNS is hosted. The tunnel needs the domain (zone) on Cloudflare. **Do not change existing DNS records** you did not create; if moving the zone is not acceptable, stop and choose the documented alternative (a scoped reverse proxy on a host you control).
2. Cloudflare dashboard → Zero Trust → Networks → Tunnels → Create a tunnel (cloudflared). Copy the tunnel **token** into `.server-secrets/cloudflared_token`.
3. Add public hostnames: `console.<OWNER_DOMAIN>` → `http://nginx:8080`, and `api.<OWNER_DOMAIN>` → `http://nginx:8080`. Do **not** add Cloudflare Access login in front of `api.` (SDK clients cannot log in through a browser page).
4. **WSL**: `zehnora/scripts/server/start.sh --with-tunnel`
5. If the university network blocks the tunnel (it stays "down" in the dashboard), report it; do not try to bypass institutional controls.

## 11. Gate C: test from another internet connection
From a phone hotspot or home network (not the university LAN), on any computer:
```bash
export ZEHNORA_BASE_URL=https://api.<OWNER_DOMAIN>/v1
export ZEHNORA_API_KEY=<customer key>
uv run --project zehnora/tests python zehnora/scripts/test-public-api.py
# revoke the key in the portal, then:
uv run --project zehnora/tests python zehnora/scripts/test-public-api.py --expect-revoked
```
Also confirm `https://api.<OWNER_DOMAIN>/key/generate` and `https://console.<OWNER_DOMAIN>/v1/models` return 404.

## 12. Connect Zehnora Desktop on the Mac
**Mac Terminal**:
```bash
ZEHNORA_API_BASE=https://api.<OWNER_DOMAIN>/v1 zehnora/scripts/mac/start-desktop.sh
```
Use an owner account key with admin-granted credits (admin role does not mean free usage).

## Operations
- **Stop** (keeps data): `zehnora/scripts/server/stop.sh`. Never run `docker compose down -v`.
- **Backup**: `zehnora/scripts/server/backup.sh`, then encrypt the folder (`age`/`gpg`) before copying it off the PC. Practise a restore into a separate test database first.
- **Power**: set Windows sleep to "Never" on AC while hosting (Settings → System → Power). Docker Desktop must start after login: this is **not** an unattended boot. After a reboot, log in, wait for Docker Desktop, then run `start.sh --with-tunnel`.
- **Updates**: `git pull` on `main`, then `start.sh` (rebuilds images). Keep `server.env` and the model folder.
