#!/bin/bash
# Creates the two separate databases/roles on first start (brief 6.3). Passwords come from Docker secrets.
set -euo pipefail
PLATFORM_PW="$(cat "$ZEHNORA_PLATFORM_DB_PASSWORD_FILE")"
LITELLM_PW="$(cat "$ZEHNORA_LITELLM_DB_PASSWORD_FILE")"
psql -v ON_ERROR_STOP=1 --username postgres <<SQL
CREATE ROLE zehnora_platform LOGIN PASSWORD '${PLATFORM_PW}';
CREATE DATABASE zehnora_platform OWNER zehnora_platform;
REVOKE ALL ON DATABASE zehnora_platform FROM PUBLIC;
CREATE ROLE zehnora_litellm LOGIN PASSWORD '${LITELLM_PW}';
CREATE DATABASE zehnora_litellm OWNER zehnora_litellm;
REVOKE ALL ON DATABASE zehnora_litellm FROM PUBLIC;
SQL
