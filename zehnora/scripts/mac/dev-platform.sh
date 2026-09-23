#!/usr/bin/env bash
# Zehnora Mac development platform: PostgreSQL + model upstream + LiteLLM + platform API + portal.
#
#   zehnora/scripts/mac/dev-platform.sh start [mock|dev-local-4b]
#   zehnora/scripts/mac/dev-platform.sh stop
#   zehnora/scripts/mac/dev-platform.sh status
#
# Profiles (both are DEVELOPMENT ONLY and never certify the GPU deployment):
#   mock          deterministic MOCK model (no real inference)
#   dev-local-4b  Qwen3.5-4B Q4_K_M on this Mac's CPU via llama.cpp, reusing an existing GGUF.
#                 This script never downloads a model (the production model lives on the GPU PC).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
R="$REPO/zehnora"
D="$REPO/.local-dev"
LOGS="$D/logs"; RUN="$D/run"; SECRETS="$D/secrets"
mkdir -p "$LOGS" "$RUN"
PG_BIN="$D/tools/postgres-17.5/bin"
NODE_BIN="$D/tools/node-v24.16.0-darwin-x64/bin"
LLAMA_SERVER="${LLAMA_SERVER_BIN:-/usr/local/bin/llama-server}"
DEV_GGUF="${ZEHNORA_DEV_GGUF:-$REPO/.local-dev/models/Qwen3.5-4B-Q4_K_M.gguf}"

PG_PORT=5433; MOCK_PORT=8101; LLAMA_PORT=8092; LITELLM_PORT=4000; API_PORT=8200; PORTAL_PORT=5173

say() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { say "ERROR: $*"; exit 1; }
port_pid() { { lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true; } | head -1; }
alive() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }

# Refuse to start on a port held by a process that is not ours.
claim_port() { # name port
  local pid; pid="$(port_pid "$2")"
  [ -z "$pid" ] && return 0
  if alive "$1" && [ "$(cat "$RUN/$1.pid")" = "$pid" ]; then return 0; fi
  # child processes (uvicorn reload, npm->vite) belong to us if their parent pid file matches
  if alive "$1" && pgrep -P "$(cat "$RUN/$1.pid")" | grep -qx "$pid"; then return 0; fi
  die "port $2 is used by another process (pid $pid, $(ps -p "$pid" -o comm= 2>/dev/null)); not touching it"
}

wait_http() { # name url seconds
  local i=0
  until curl -sf "$2" >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -ge "$3" ] && die "$1 did not become ready (see $LOGS)"
    sleep 1
  done
  say "$1 ready (${i}s)"
}

start_postgres() {
  if "$PG_BIN/pg_ctl" -D "$D/pgdata" status >/dev/null 2>&1; then say "postgres already running"; return; fi
  claim_port postgres "$PG_PORT"
  "$PG_BIN/pg_ctl" -D "$D/pgdata" -l "$LOGS/postgres.log" -w start -o "-p $PG_PORT -c listen_addresses=127.0.0.1 -k $D" >/dev/null
  say "postgres ready on 127.0.0.1:$PG_PORT"
}

start_mock() {
  alive mock && { say "mock already running"; return; }
  claim_port mock "$MOCK_PORT"
  (cd "$R/infra/mock-inference" && nohup .venv/bin/uvicorn mock_server:app --host 127.0.0.1 --port "$MOCK_PORT" >>"$LOGS/mock.log" 2>&1 & echo $! >"$RUN/mock.pid")
  wait_http "MOCK model (development only)" "http://127.0.0.1:$MOCK_PORT/health" 30
}

start_llama() {
  alive llama && { say "llama-server already running"; return; }
  [ -f "$DEV_GGUF" ] || die "dev model not found at $DEV_GGUF. This script does not download models; set ZEHNORA_DEV_GGUF to an existing small GGUF."
  claim_port llama "$LLAMA_PORT"
  [ -f "$SECRETS/llama-api-key" ] || (umask 077; openssl rand -hex 24 >"$SECRETS/llama-api-key")
  nohup "$LLAMA_SERVER" --model "$DEV_GGUF" --alias mac-demo-model --host 127.0.0.1 --port "$LLAMA_PORT" \
    --api-key-file "$SECRETS/llama-api-key" --ctx-size 8192 --parallel 1 --n-predict 1536 --threads 6 \
    --jinja --reasoning "${ZEHNORA_DEV_REASONING:-off}" --temp 0.6 --top-k 20 --top-p 0.8 --no-webui >>"$LOGS/llama-server.log" 2>&1 &
  echo $! >"$RUN/llama.pid"
  wait_http "llama-server (Qwen3.5-4B, CPU, development stand-in)" "http://127.0.0.1:$LLAMA_PORT/health" 120
}

start_litellm() { # config
  alive litellm && { say "litellm already running ($(cat "$RUN/litellm.profile" 2>/dev/null))"; return; }
  claim_port litellm "$LITELLM_PORT"
  local lp; lp="$(cat "$SECRETS/pg-litellm-password")"
  (
    cd "$R/infra/litellm"
    export PATH="$PWD/.venv/bin:$PATH" LITELLM_MASTER_KEY="$(cat "$SECRETS/litellm-master-key")" \
      DATABASE_URL="postgresql://zehnora_litellm:$lp@127.0.0.1:$PG_PORT/zehnora_litellm" \
      PRISMA_NODEENV_CACHE_DIR="$D/prisma-nodeenv" PRISMA_BINARY_CACHE_DIR="$D/prisma-binaries" \
      LITELLM_TELEMETRY=False DISABLE_ADMIN_UI=True STORE_MODEL_IN_DB=False
    [ -f "$SECRETS/llama-api-key" ] && export LLAMA_API_KEY="$(cat "$SECRETS/llama-api-key")"
    nohup .venv/bin/litellm --config "config.$1.yaml" --host 127.0.0.1 --port "$LITELLM_PORT" >>"$LOGS/litellm.log" 2>&1 &
    echo $! >"$RUN/litellm.pid"
  )
  echo "$1" >"$RUN/litellm.profile"
  wait_http "litellm ($1)" "http://127.0.0.1:$LITELLM_PORT/health/liveliness" 180
}

seed_catalog() { # profile
  local identity context
  case "$1" in
    mock) identity="MOCK (zehnora-mock via LiteLLM, development only - not a model)"; context=4096 ;;
    dev-local-4b) identity="Qwen/Qwen3.5-4B Q4_K_M GGUF (unsloth) via llama.cpp b9960 on Intel Mac CPU - development stand-in, not the GPU deployment"; context=8192 ;;
  esac
  (cd "$R/platform-api" && uv run --frozen python -m app.cli seed-model --alias zehnora-coder --identity "$identity" \
     --description "Zehnora coding model ($1 profile)" --context "$context" --max-output 1024 --default-output 512 >/dev/null)
  say "model catalog: zehnora-coder -> $identity"
}

start_api() { # profile
  alive platform-api && { say "platform API already running"; return; }
  claim_port platform-api "$API_PORT"
  (cd "$R/platform-api" && uv run --frozen alembic upgrade head >/dev/null 2>&1 \
     && ZEHNORA_PROFILE="$1" nohup uv run --frozen uvicorn app.main:app --host 127.0.0.1 --port "$API_PORT" >>"$LOGS/platform-api.log" 2>&1 & echo $! >"$RUN/platform-api.pid")
  wait_http "platform API" "http://127.0.0.1:$API_PORT/platform/v1/health" 60
}

start_portal() {
  alive portal && { say "portal already running"; return; }
  claim_port portal "$PORTAL_PORT"
  (cd "$R/portal" && PATH="$NODE_BIN:$PATH" nohup npm run dev >>"$LOGS/portal.log" 2>&1 & echo $! >"$RUN/portal.pid")
  wait_http "portal" "http://127.0.0.1:$PORTAL_PORT/" 60
}

stop_one() { # name
  alive "$1" || { rm -f "$RUN/$1.pid"; return 0; }
  local pid; pid="$(cat "$RUN/$1.pid")"
  pkill -TERM -P "$pid" 2>/dev/null || true   # children of this pid only (uvicorn/vite)
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 15); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  rm -f "$RUN/$1.pid"; say "stopped $1"
}

case "${1:-status}" in
  start)
    profile="${2:-mock}"
    [[ "$profile" =~ ^(mock|dev-local-4b)$ ]] || die "profile must be mock or dev-local-4b"
    if alive litellm && [ "$(cat "$RUN/litellm.profile" 2>/dev/null)" != "$profile" ]; then
      say "switching profile -> $profile"; stop_one platform-api; stop_one litellm
    fi
    start_postgres
    if [ "$profile" = mock ]; then start_mock; else start_llama; fi
    start_litellm "$profile"
    seed_catalog "$profile"
    start_api "$profile"
    start_portal
    say "PROFILE: $profile  (development only; GPU acceptance tests run on the university PC)"
    say "Portal: http://127.0.0.1:$PORTAL_PORT   API base: http://127.0.0.1:$API_PORT/v1"
    ;;
  stop)
    for s in portal platform-api litellm llama mock; do stop_one "$s"; done
    "$PG_BIN/pg_ctl" -D "$D/pgdata" -m fast -w stop >/dev/null 2>&1 && say "stopped postgres" || true
    say "all Zehnora dev services stopped (data kept)"
    ;;
  status)
    "$PG_BIN/pg_ctl" -D "$D/pgdata" status >/dev/null 2>&1 && echo "postgres      running :$PG_PORT" || echo "postgres      stopped"
    for s in mock llama litellm platform-api portal; do
      if alive "$s"; then echo "$(printf '%-13s' "$s") running (pid $(cat "$RUN/$s.pid"))"; else echo "$(printf '%-13s' "$s") stopped"; fi
    done
    echo "profile       $(cat "$RUN/litellm.profile" 2>/dev/null || echo unknown)"
    ;;
  *) die "usage: $0 start [mock|dev-local-4b] | stop | status" ;;
esac
