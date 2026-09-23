#!/usr/bin/env bash
# Auto-deploy loop, run by the "deployer" container (enable-autodeploy.sh). Every ZEHNORA_DEPLOY_INTERVAL seconds it
# fetches origin/main; on a new commit it fast-forwards the checkout (as the repository owner), rebuilds the portal
# when it changed, and runs start.sh, which rebuilds and recreates only what changed. Local edits are never
# overwritten: if the checkout cannot fast-forward, the update is skipped and logged.
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SELF="$REPO/zehnora/scripts/server/autodeploy.sh"
INTERVAL="${ZEHNORA_DEPLOY_INTERVAL:-300}"
OWNER="${ZEHNORA_HOST_UID:?}:${ZEHNORA_HOST_GID:?}"
say() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
git_owner() { su-exec "$OWNER" env HOME=/tmp git -C "$REPO" "$@"; }

build_portal() {
  say "portal changed: building it"
  docker run --rm -u "$OWNER" -e HOME=/tmp -v "$REPO/zehnora/portal:$REPO/zehnora/portal" -w "$REPO/zehnora/portal" \
    node:24.16.0-slim sh -c 'npm ci --no-audit --no-fund && npm run build'
}

deploy() {
  local old new changed tunnel=""
  git_owner fetch -q origin main || { say "fetch failed; will retry"; return; }
  old="$(git_owner rev-parse HEAD)"; new="$(git_owner rev-parse origin/main)"
  [ "$old" = "$new" ] && return
  changed="$(git_owner diff --name-only "$old" "$new")"
  git_owner merge --ff-only -q origin/main || { say "cannot fast-forward (local changes?); update skipped"; return; }
  say "updated ${old:0:7} -> ${new:0:7}: $(git_owner log -1 --format=%s)"
  if grep -q '^zehnora/portal/' <<<"$changed"; then build_portal || { say "portal build failed; services not restarted"; return; }; fi
  [ "$(docker inspect -f '{{.State.Running}}' zehnora-cloudflared-1 2>/dev/null)" = true ] && tunnel=--with-tunnel
  "$REPO/zehnora/scripts/server/start.sh" $tunnel && say "deployed ${new:0:7}" || say "start.sh failed for ${new:0:7} (see above)"
  if grep -q '^zehnora/scripts/server/autodeploy.sh$' <<<"$changed"; then say "reloading the updated deploy loop"; exec "$SELF"; fi
}

say "auto-deploy watching origin/main every ${INTERVAL}s (repo $REPO)"
while true; do
  deploy
  sleep "$INTERVAL"
done
