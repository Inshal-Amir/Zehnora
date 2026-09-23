# Zehnora on the university GPU PC (step by step)

This guide deploys the **server profile**: the model server (llama.cpp by default, or vLLM) + the real model, LiteLLM, PostgreSQL, the platform API, the portal, nginx and (last) the Cloudflare Tunnel. It is written for the known target (Ryzen 7 9700X, 64 GB RAM, RTX 4070 Ti SUPER 16 GB), but **inspect the real hardware first** (step 1).

Every command block says where it runs:
- **PowerShell** = Windows PowerShell on the GPU PC
- **WSL** = the Ubuntu (WSL2) terminal on the GPU PC

> **Status:** these steps were written and syntax-checked on the development Mac. They have **not been run on the GPU PC yet**. Record the real output of each step in `zehnora/docs/STATUS.md`.

**Model rule:** the model is downloaded **only here**, on the GPU PC, never on the Mac.

---

## 0. What you need before starting
- Admin rights on the PC (for installing drivers, WSL and Docker Desktop, if missing).
- The private GitHub repository URL and a way to log in to GitHub (browser or a personal token typed at the prompt; **never put a token inside the clone URL**).
- About 60 GB free on a fast SSD (model about 22 GB, images about 10 GB, database and backups).
- 64 GB system RAM recommended: the default MoE model keeps part of its experts in RAM.
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
sudo usermod -aG docker $USER                      # then close and reopen the Ubuntu window
docker run --rm --gpus all ubuntu nvidia-smi       # must show the RTX card from inside a container
sudo apt-get update && sudo apt-get install -y git curl openssl python3
curl -LsSf https://astral.sh/uv/install.sh | sh && source $HOME/.local/bin/env   # uv (for the model download)
cd ~ && git clone https://github.com/Inshal-Amir/Zehnora.git zehnora
cd ~/zehnora
```
Keep the repository in `~/zehnora` (Linux filesystem), not under `/mnt/c`, for speed.

## 3. Create the server secrets
**WSL**:
```bash
cd ~/zehnora && zehnora/scripts/server/init-secrets.sh
mkdir -p ~/zehnora-models
sed -i "s#^ZEHNORA_MODEL_DIR=.*#ZEHNORA_MODEL_DIR=$HOME/zehnora-models#" .server-secrets/server.env
# OWNER_DOMAIN is set in step 10, once the domain is known
```
`.server-secrets/` is git-ignored and mode 600. Never copy secrets or databases from the Mac.

## 4. Model and engine (defaults in `server.env`)
- **Engine `llamacpp` (default)**: `ghcr.io/ggml-org/llama.cpp:server-cuda-v0.4.1`.
- **Model**: `unsloth/Qwen3.6-35B-A3B-GGUF` @ `a483e9e6cbd595906af30beda3187c2663a1118c`, file `Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf` (22.4 GB, sha256 in `server.env`). This is a MoE model with 35B parameters, 3B of them active per token, and it scores 73.4% on SWE-bench Verified. The file is larger than 16 GB of VRAM, so `--fit on` keeps attention/shared layers on the GPU and puts the remaining experts in system RAM.
- **Settings**: context 65,536, one request at a time, thinking on, and the coding sampling from the model card (temperature 0.6, top-p 0.95, top-k 20). Clients can turn thinking off per request with `"chat_template_kwargs": {"enable_thinking": false}`.
- **Engine `vllm` (alternative, many users)**: set `ZEHNORA_ENGINE=vllm` with a model that fits in VRAM (see the comments in `server.env`) and verify the tool-call parser first: `docker run --rm vllm/vllm-openai:v0.29.0 --help | grep -A6 -- '--tool-call-parser'`.

## 5. Download the model (pinned revision, outside Git)
**WSL**:
```bash
cd ~/zehnora && zehnora/scripts/server/download-model.sh
```
Uses `ZEHNORA_MODEL_REPO` + `ZEHNORA_MODEL_REVISION` (full commit sha) + `ZEHNORA_MODEL_FILE` from `server.env`. The download resumes if interrupted. The file must match `ZEHNORA_MODEL_SHA256`. The script writes `SHA256SUMS` and `ZEHNORA-PROVENANCE.txt` next to the weights; record both in `docs/MODEL-EVALUATION.md`.

## 6. Build the portal
**WSL**:
```bash
# Node 24 inside WSL (once)
cd ~ && curl -LO https://nodejs.org/dist/v24.16.0/node-v24.16.0-linux-x64.tar.xz
curl -LO https://nodejs.org/dist/v24.16.0/SHASUMS256.txt
grep node-v24.16.0-linux-x64.tar.xz SHASUMS256.txt | sha256sum -c -     # must print OK
mkdir -p ~/.local/node && tar xJf node-v24.16.0-linux-x64.tar.xz -C ~/.local/node --strip-components=1
echo 'export PATH="$HOME/.local/node/bin:$PATH"' >> ~/.bashrc && export PATH="$HOME/.local/node/bin:$PATH"
rm node-v24.16.0-linux-x64.tar.xz SHASUMS256.txt

cd ~/zehnora/zehnora/portal && npm ci && npm run build
```

## 7. Start the services (local only, no tunnel yet)
**WSL**:
```bash
cd ~/zehnora && zehnora/scripts/server/start.sh
zehnora/scripts/server/health.sh
```
`start.sh` builds the LiteLLM and platform images, starts PostgreSQL and the model server, waits for health (loading 22 GB takes a few minutes), then LiteLLM, the platform API and nginx (`127.0.0.1:8080` only). It prints the model deployment identity and GPU memory.

## 8. One-time platform setup
**WSL**:
```bash
zehnora/scripts/server/bootstrap-admin.sh you@example.com   # first administrator; password prompted (12+ characters), not logged
zehnora/scripts/server/setup-platform.sh                    # model catalog entry, playground gateway key, public API base
```
`setup-platform.sh` records the deployed model identity (file, revision, engine, GPU) with context 65,536 and output limits 16,384 max / 8,192 default (thinking tokens count as output). It stores the playground key and `https://api.<OWNER_DOMAIN>/v1` in `.server-secrets/platform.env`, then restarts the platform API. Run it again after changing `OWNER_DOMAIN`.

## 9. Gate B: test locally BEFORE exposing anything
**WSL**:
```bash
curl -s -H "Host: api.<OWNER_DOMAIN>" http://127.0.0.1:8080/v1/models          # expect 401 (no key)
```
Then in a browser on the PC, open `http://127.0.0.1:8080` with the Host header set. The simplest way is to add `127.0.0.1 console.<OWNER_DOMAIN> api.<OWNER_DOMAIN>` to `C:\Windows\System32\drivers\etc\hosts` **temporarily**. Then:
1. Register a customer, grant credits as admin, create a key.
2. **WSL**: `ZEHNORA_BASE_URL=http://api.<OWNER_DOMAIN>:8080/v1 ZEHNORA_API_KEY=<key> uv run --project zehnora/tests python zehnora/scripts/test-public-api.py --no-thinking` (the test uses short answer budgets)
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
uv run --project zehnora/tests python zehnora/scripts/test-public-api.py --no-thinking
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
- **Hardware guard** (container `zehnora-guard-1`, started by `start.sh`, restarts with Docker): every 10 s it reads the GPU temperature, power and thermal-slowdown flags with `nvidia-smi` and the available RAM. At **80 °C** it stops the model so the GPU idles, and starts it again at **70 °C**. At **87 °C**, when a cool-down takes longer than 15 minutes, or when available RAM drops below 1,024 MiB, it stops the model and keeps it stopped. These limits are always kept below the card's own reported limits (max operating temperature − 5, slowdown temperature − 3). A lock file `.server-state/guard.lock` then blocks `start.sh` and auto-deploy. Check the PC (fans, dust, airflow, other GPU programs), then run `zehnora/scripts/server/guard-reset.sh`. Log: `.server-state/guard.log` or `docker logs zehnora-guard-1`. Thresholds are in `server.env` (`ZEHNORA_GUARD_*`). The CPU temperature cannot be read from WSL; the Ryzen CPU protects itself by throttling.
- **Updates (automatic)**: `zehnora/scripts/server/enable-autodeploy.sh` starts a small `deployer` container that checks `origin/main` every 5 minutes. On a new commit it fast-forwards the checkout (as your user), rebuilds the portal if it changed, and runs `start.sh`, which rebuilds and recreates only what changed. It restarts with Docker Desktop. It never overwrites local edits: if the checkout cannot fast-forward, the update is skipped and logged. Logs: `docker logs -f zehnora-deployer-1`. Turn it off with `enable-autodeploy.sh --off`. Everything pushed to `main` goes live, so push only tested commits.
- **Updates (manual)**: `git pull` on `main`, then `start.sh`. Keep `server.env` and the model folder.
