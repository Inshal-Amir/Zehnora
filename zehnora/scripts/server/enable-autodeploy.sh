#!/usr/bin/env bash
# Start (or update) the auto-deploy container: it pulls new commits on origin/main and redeploys automatically.
#   enable-autodeploy.sh          start it
#   enable-autodeploy.sh --off    stop it
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
if [ "${1:-}" = "--off" ]; then dc --profile autodeploy stop deployer && dc --profile autodeploy rm -f deployer; say "auto-deploy off"; exit 0; fi
git -C "$REPO" diff --quiet && git -C "$REPO" diff --cached --quiet || die "the checkout has local changes; commit or discard them first"
dc --profile autodeploy up -d --build deployer
say "auto-deploy on: checks origin/main every ${ZEHNORA_DEPLOY_INTERVAL:-300}s. Logs: docker logs -f zehnora-deployer-1"
