#!/usr/bin/env bash
# Zehnora Desktop (Mac): local MongoDB + LibreChat backend/UI + workspace connector, then Electron.
#
#   zehnora/scripts/mac/start-desktop.sh                  # services + Electron window
#   zehnora/scripts/mac/start-desktop.sh --services-only  # services only (tests, headless)
#
# Environment (all optional):
#   ZEHNORA_API_BASE     model API base (default http://127.0.0.1:8200/v1; production https://api.<OWNER_DOMAIN>/v1)
#   ZEHNORA_CLIENT_DATA  client state directory (default <repo>/.local-dev/client)
# The customer API key is read from $ZEHNORA_CLIENT_DATA/secrets/zehnora-api-key (mode 600) or
# supplied by the Electron shell from the OS keychain. It never reaches the browser renderer.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
R="$REPO/zehnora"
CD="${ZEHNORA_CLIENT_DATA:-$REPO/.local-dev/client}"
LOGS="$CD/logs"; RUN="$CD/run"; SEC="$CD/secrets"
mkdir -p "$LOGS" "$RUN" "$CD/mongo" && (umask 077; mkdir -p "$SEC")
NODE_BIN="$REPO/.local-dev/tools/node-v24.16.0-darwin-x64/bin"
MONGOD="${MONGOD_BIN:-/usr/local/bin/mongod}"
API_BASE="${ZEHNORA_API_BASE:-http://127.0.0.1:8200/v1}"
MONGO_PORT=27028; LC_PORT=3090; APPROVAL_PORT=3099
SERVICES_ONLY=0; [ "${1:-}" = "--services-only" ] && SERVICES_ONLY=1

say() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { say "ERROR: $*"; exit 1; }
port_pid() { { lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true; } | head -1; }
alive() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }
claim() { local p; p="$(port_pid "$2")"; [ -z "$p" ] && return 0; alive "$1" && [ "$(cat "$RUN/$1.pid")" = "$p" ] && return 0
          die "port $2 is used by another process (pid $p $(ps -p "$p" -o comm= 2>/dev/null)); not touching it"; }
wait_for() { local i=0; until "$@" >/dev/null 2>&1; do i=$((i+1)); [ $i -ge 120 ] && return 1; sleep 1; done; }

[ -x "$MONGOD" ] || die "mongod not found at $MONGOD (install MongoDB Community or set MONGOD_BIN)"
[ -f "$REPO/client/dist/index.html" ] || die "LibreChat UI not built: run 'npm ci && npm run frontend' in $REPO"
[ -x "$R/connectors/workspace/.venv/bin/python" ] || die "workspace connector env missing: cd zehnora/connectors/workspace && uv sync"

# One-time client secrets (LibreChat crypto + approval bridge secret).
if [ ! -f "$SEC/librechat.env" ]; then
  (umask 077; cat >"$SEC/librechat.env" <<EOF
CREDS_KEY=$(openssl rand -hex 32)
CREDS_IV=$(openssl rand -hex 16)
JWT_SECRET=$(openssl rand -hex 32)
JWT_REFRESH_SECRET=$(openssl rand -hex 32)
EOF
  )
fi
[ -f "$SEC/approval-secret" ] || (umask 077; openssl rand -hex 32 >"$SEC/approval-secret")
[ -f "$SEC/zehnora-api-key" ] || [ -n "${ZEHNORA_API_KEY:-}" ] || die "no Zehnora API key: create one in the portal and save it to $SEC/zehnora-api-key (chmod 600)"

WS_CONFIG="$HOME/.zehnora/workspace.json"
mkdir -p "$HOME/.zehnora"
[ -f "$WS_CONFIG" ] || printf '{"workspace_root": "%s"}\n' "$HOME/Desktop/Zehnora-Workspace" >"$WS_CONFIG"

sed -e "s|__REPO__|$REPO|g" -e "s|__WORKSPACE_CONFIG__|$WS_CONFIG|g" -e "s|__CONNECTOR_DATA__|$CD/workspace-connector|g" \
    -e "s|__APPROVAL_URL__|http://127.0.0.1:$APPROVAL_PORT/approve|g" -e "s|__APPROVAL_SECRET_FILE__|$SEC/approval-secret|g" \
    -e "s|__PLAYWRIGHT_BROWSERS__|$REPO/.local-dev/playwright-browsers|g" \
    "$R/infra/client/librechat.yaml.template" >"$CD/librechat.yaml"
# Google Workspace connector only when the owner has supplied an OAuth client file.
if [ -f "$SEC/google-client-secret.json" ]; then
  (umask 077; mkdir -p "$SEC/google-credentials")
  # insert the connector block before the "endpoints:" section
  python3 - "$CD/librechat.yaml" "$R/infra/client/google-mcp.yaml.part" "$REPO" "$SEC" <<'PY'
import sys
cfg, part, repo, sec = sys.argv[1:]
block = open(part).read().replace("__REPO__", repo).replace("__GOOGLE_CLIENT_SECRET__", f"{sec}/google-client-secret.json") \
                         .replace("__GOOGLE_CREDENTIALS_DIR__", f"{sec}/google-credentials")
text = open(cfg).read()
open(cfg, "w").write(text.replace("\nendpoints:\n", "\n" + block + "\nendpoints:\n", 1))
PY
  say "Google Workspace connector enabled"
else
  say "Google Workspace connector off (no $SEC/google-client-secret.json; see zehnora/docs/GOOGLE-SETUP.md)"
fi

# 1. MongoDB for LibreChat (client-local, loopback)
if alive mongod; then say "mongod already running"; else
  claim mongod "$MONGO_PORT"
  nohup "$MONGOD" --dbpath "$CD/mongo" --bind_ip 127.0.0.1 --port "$MONGO_PORT" --logpath "$LOGS/mongod.log" --logappend >/dev/null 2>&1 &
  echo $! >"$RUN/mongod.pid"
  wait_for sh -c "lsof -nP -iTCP:$MONGO_PORT -sTCP:LISTEN" || die "mongod did not start (see $LOGS/mongod.log)"
  say "mongod ready on 127.0.0.1:$MONGO_PORT"
fi

# 2. SearXNG (web search for the search connector; needs internet)
SEARXNG_DIR="${ZEHNORA_SEARXNG_DIR:-$REPO/.local-dev/tools/searxng}"
if alive searxng; then say "SearXNG already running"; elif [ -x "$SEARXNG_DIR/.venv/bin/python" ]; then
  claim searxng 8888
  [ -f "$SEC/searxng-secret" ] || (umask 077; openssl rand -hex 32 >"$SEC/searxng-secret")
  (cd "$SEARXNG_DIR" && SEARXNG_SETTINGS_PATH="$R/connectors/search/searxng-settings.yml" SEARXNG_SECRET="$(cat "$SEC/searxng-secret")" \
     nohup .venv/bin/python -m searx.webapp >>"$LOGS/searxng.log" 2>&1 & echo $! >"$RUN/searxng.pid")
  wait_for curl -sf http://127.0.0.1:8888/healthz && say "SearXNG ready on 127.0.0.1:8888" || say "WARNING: SearXNG did not start; web search will report errors"
else
  say "WARNING: SearXNG not installed at $SEARXNG_DIR; web search will report errors (see MAC-DEVELOPMENT.md)"
fi

# 3. LibreChat backend (serves the UI); key injected into its environment only
if alive librechat; then say "LibreChat already running"; else
  claim librechat "$LC_PORT"
  (
    set -a; . "$SEC/librechat.env"; set +a
    export HOST=127.0.0.1 PORT=$LC_PORT DOMAIN_CLIENT="http://127.0.0.1:$LC_PORT" DOMAIN_SERVER="http://127.0.0.1:$LC_PORT" \
      MONGO_URI="mongodb://127.0.0.1:$MONGO_PORT/ZehnoraDesktop" CONFIG_PATH="$CD/librechat.yaml" ENDPOINTS=agents,custom \
      SEARCH=false NO_INDEX=true APP_TITLE="Zehnora Desktop" CUSTOM_FOOTER="Zehnora Desktop · built on LibreChat (MIT)" \
      ALLOW_EMAIL_LOGIN=true ALLOW_REGISTRATION=false ALLOW_SOCIAL_LOGIN=false ALLOW_PASSWORD_RESET=false \
      ALLOW_UNVERIFIED_EMAIL_LOGIN=true LIMIT_CONCURRENT_MESSAGES=true CONCURRENT_MESSAGE_MAX=1 BAN_VIOLATIONS=false \
      ZEHNORA_API_BASE="$API_BASE" NODE_ENV=production TRUST_PROXY=1
    [ -n "${ZEHNORA_API_KEY:-}" ] || export ZEHNORA_API_KEY="$(cat "$SEC/zehnora-api-key")"
    cd "$REPO"
    nohup "$NODE_BIN/node" "$REPO/api/server/index.js" >>"$LOGS/librechat.log" 2>&1 &
    echo $! >"$RUN/librechat.pid"
  )
  wait_for curl -sf "http://127.0.0.1:$LC_PORT/health" || die "LibreChat did not start (see $LOGS/librechat.log)"
  chat_ready() { [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' \
                      "http://127.0.0.1:$LC_PORT/api/agents/chat/agents")" != "503" ]; }
  wait_for chat_ready || die "LibreChat chat endpoint not ready"
  say "LibreChat ready: http://127.0.0.1:$LC_PORT (model API: $API_BASE)"
fi

say "workspace: $(python3 -c "import json;print(json.load(open('$WS_CONFIG'))['workspace_root'])")"
if [ "$SERVICES_ONLY" = 0 ]; then
  [ -d "$R/desktop/node_modules" ] || die "Electron shell not installed: cd zehnora/desktop && npm install"
  cd "$R/desktop"
  ZEHNORA_CLIENT_DATA="$CD" ZEHNORA_LIBRECHAT_URL="http://127.0.0.1:$LC_PORT" ZEHNORA_APPROVAL_PORT=$APPROVAL_PORT \
    ZEHNORA_APPROVAL_SECRET_FILE="$SEC/approval-secret" ZEHNORA_WORKSPACE_CONFIG="$WS_CONFIG" \
    PATH="$NODE_BIN:$PATH" nohup "$R/desktop/node_modules/.bin/electron" . ${ZEHNORA_ELECTRON_ARGS:-} >>"$LOGS/electron.log" 2>&1 &
  echo $! >"$RUN/electron.pid"
  say "Zehnora Desktop window starting"
fi
