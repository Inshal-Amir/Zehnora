#!/bin/sh
# Reads Docker secrets into the environment LiteLLM expects, then starts the proxy.
set -eu
export LITELLM_MASTER_KEY="$(cat /run/secrets/litellm_master_key)"
export VLLM_API_KEY="$(cat /run/secrets/vllm_api_key)"
export DATABASE_URL="postgresql://roshvyn_litellm:$(cat /run/secrets/pg_litellm_password)@postgres:5432/roshvyn_litellm"
exec litellm --config "/app/${1:-config.gpu.yaml}" --host 0.0.0.0 --port 4000
