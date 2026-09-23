#!/usr/bin/env bash
# Stop Roshvyn Desktop's own processes (Electron, LibreChat, client MongoDB). Keeps chats, data and workspace.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CD="${ROSHVYN_CLIENT_DATA:-$REPO/.local-dev/client}"
RUN="$CD/run"
say() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
for s in electron librechat searxng mongod; do
  f="$RUN/$s.pid"
  [ -f "$f" ] || continue
  pid="$(cat "$f")"
  if kill -0 "$pid" 2>/dev/null; then
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 15); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" || true
    say "stopped $s"
  fi
  rm -f "$f"
done
say "Roshvyn Desktop services stopped (chats and workspace kept)"
