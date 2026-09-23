#!/usr/bin/env bash
# Start the server profile in dependency order and wait for readiness.
#   start.sh                 local-only (nginx on 127.0.0.1:8080)
#   start.sh --with-tunnel   also start the Cloudflare Tunnel connector (after local tests pass)
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
[ -e "$MODEL_PATH" ] || die "model not downloaded ($MODEL_PATH): run download-model.sh"
[ -f "$REPO/zehnora/portal/dist/index.html" ] || die "portal not built: cd zehnora/portal && npm ci && npm run build"
docker info >/dev/null 2>&1 || die "Docker is not running (start Docker Desktop with the WSL2 backend)"
say "building images (litellm, platform-api)"; dc build
say "starting postgres + model ($ZEHNORA_ENGINE; loading can take minutes)"; dc up -d postgres model
wait_healthy() { local s="$1" i=0; until [ "$(docker inspect -f '{{.State.Health.Status}}' "zehnora-$s-1" 2>/dev/null)" = healthy ]; do
  i=$((i+1)); [ $i -ge 180 ] && die "$s not healthy (dc logs $s)"; sleep 5; done; say "$s healthy"; }
wait_healthy postgres; wait_healthy model
dc up -d litellm; wait_healthy litellm
dc up -d platform-api; wait_healthy platform-api
dc up -d nginx
[ "${1:-}" = "--with-tunnel" ] && { dc --profile tunnel up -d cloudflared; say "tunnel connector started"; }
say "model deployment: $ZEHNORA_MODEL_REPO @ ${ZEHNORA_MODEL_REVISION:0:12} ${ZEHNORA_MODEL_FILE:-} ($ZEHNORA_ENGINE, ctx ${ZEHNORA_MAX_MODEL_LEN:-})"
docker exec zehnora-model-1 nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader || true
say "local check: curl -s -H 'Host: api.$OWNER_DOMAIN' http://127.0.0.1:8080/v1/models"
