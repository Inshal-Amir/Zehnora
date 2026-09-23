#!/bin/sh
# Reads Docker secrets into the environment LiteLLM expects, then starts the proxy as the unprivileged litellm user.
# It starts as root because Compose mounts file secrets with the host file's owner and mode (600).
set -eu
export LITELLM_MASTER_KEY="$(cat /run/secrets/litellm_master_key)"
export MODEL_API_KEY="$(cat /run/secrets/vllm_api_key)"
export DATABASE_URL="postgresql://zehnora_litellm:$(cat /run/secrets/pg_litellm_password)@postgres:5432/zehnora_litellm"
exec python -c '
import os, sys
if os.getuid() == 0:
    os.setgroups([]); os.setgid(10001); os.setuid(10001)
os.environ["HOME"] = "/app"
os.execvp("litellm", ["litellm", *sys.argv[1:]])
' --config "/app/${1:-config.llamacpp.yaml}" --host 0.0.0.0 --port 4000
