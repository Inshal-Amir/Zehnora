#!/usr/bin/env bash
# One-time generation of server secrets on the GPU PC (idempotent: existing files are kept).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
S="$REPO/.server-secrets"; umask 077; mkdir -p "$S"
gen() { [ -s "$S/$1" ] || openssl rand -hex 24 >"$S/$1"; }
gen pg_superuser_password; gen pg_platform_password; gen pg_litellm_password; gen vllm_api_key
[ -s "$S/litellm_master_key" ] || echo "sk-$(openssl rand -hex 24)" >"$S/litellm_master_key"
[ -s "$S/cloudflared_token" ] || echo "REPLACE-WITH-TUNNEL-TOKEN" >"$S/cloudflared_token"
[ -f "$S/server.env" ] || cp "$REPO/roshvyn/infra/server/server.env.example" "$S/server.env"
if [ ! -s "$S/platform.env" ]; then
  cat >"$S/platform.env" <<ENV
ROSHVYN_DATABASE_URL=postgresql+psycopg://roshvyn_platform:$(cat "$S/pg_platform_password")@postgres:5432/roshvyn_platform
ROSHVYN_LITELLM_MASTER_KEY=$(cat "$S/litellm_master_key")
ROSHVYN_KEY_HMAC_SECRET=$(openssl rand -hex 32)
ROSHVYN_SESSION_SECRET=$(openssl rand -hex 32)
ROSHVYN_CORS_ORIGINS=[]
ROSHVYN_PUBLIC_API_BASE=https://api.<OWNER_DOMAIN>/v1
ROSHVYN_PLAYGROUND_GATEWAY_KEY=
ENV
fi
echo "Secrets in $S (mode 600). Edit server.env and set OWNER_DOMAIN + model settings; put the tunnel token in cloudflared_token."
