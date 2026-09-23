#!/usr/bin/env bash
# One-time (re-runnable) platform setup after start.sh: model catalog entry, portal playground gateway key and
# public API base in platform.env, then restart the platform API. The first admin is created separately with
# bootstrap-admin.sh (it prompts for a password).
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
API=zehnora-platform-api-1
[ "$(docker inspect -f '{{.State.Health.Status}}' "$API" 2>/dev/null)" = healthy ] || die "platform API is not running: run start.sh first"

if [ "$ZEHNORA_ENGINE" = llamacpp ]; then
  identity="$ZEHNORA_MODEL_FILE ($ZEHNORA_MODEL_REPO @ ${ZEHNORA_MODEL_REVISION:0:7}), llama.cpp ${LLAMACPP_IMAGE_TAG:-server-cuda-v0.4.1}"
  limits=(--context "${ZEHNORA_MAX_MODEL_LEN:-65536}" --max-output 16384 --default-output 8192)
else
  identity="$ZEHNORA_MODEL_REPO @ ${ZEHNORA_MODEL_REVISION:0:7} BF16, vLLM ${VLLM_IMAGE_TAG:-v0.29.0}"
  limits=(--context "${ZEHNORA_MAX_MODEL_LEN:-4096}" --max-output 1024 --default-output 512)
fi
gpu="$(docker exec zehnora-model-1 nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || true)"
docker exec "$API" python -m app.cli seed-model --alias zehnora-coder --identity "$identity${gpu:+, $gpu}" "${limits[@]}"

ENVF="$SECRETS/platform.env"
set_env() { # name value: replace or append one line, keeping the file private
  local tmp; tmp="$(mktemp "$SECRETS/.platform.env.XXXXXX")"
  grep -v "^$1=" "$ENVF" >"$tmp" || true
  printf '%s=%s\n' "$1" "$2" >>"$tmp"
  chmod 600 "$tmp" && mv "$tmp" "$ENVF"
}
if grep -q '^ZEHNORA_PLAYGROUND_GATEWAY_KEY=.\+' "$ENVF"; then
  say "playground gateway key already set"
else
  key="$(docker exec "$API" python -m app.cli create-gateway-key 2>/dev/null | head -1)"
  [ -n "$key" ] || die "could not create the playground gateway key (see: docker logs $API)"
  set_env ZEHNORA_PLAYGROUND_GATEWAY_KEY "$key"
  say "playground gateway key created and stored in platform.env"
fi
set_env ZEHNORA_PUBLIC_API_BASE "https://api.$OWNER_DOMAIN/v1"

dc up -d platform-api >/dev/null
i=0; until [ "$(docker inspect -f '{{.State.Health.Status}}' "$API" 2>/dev/null)" = healthy ]; do
  i=$((i+1)); [ $i -ge 60 ] && die "platform API not healthy after restart (docker logs $API)"; sleep 3; done
say "platform ready: model zehnora-coder, playground key set, public API base https://api.$OWNER_DOMAIN/v1"
