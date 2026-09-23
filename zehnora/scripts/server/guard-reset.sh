#!/usr/bin/env bash
# After the guard shut the model down (see .server-state/guard.log): check the PC (fans, dust, airflow, other GPU
# programs), then run this to clear the lock and start everything again.
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
LOCK="$REPO/.server-state/guard.lock"
[ -f "$LOCK" ] || { say "no guard lock; nothing to reset"; exit 0; }
say "clearing guard lock: $(cat "$LOCK")"
rm -f "$LOCK"
exec "$REPO/zehnora/scripts/server/start.sh" "$@"
