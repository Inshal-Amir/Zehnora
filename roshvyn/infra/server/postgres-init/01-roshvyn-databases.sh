#!/bin/bash
# Creates the two separate databases/roles on first start (brief 6.3). Passwords come from Docker secrets.
set -euo pipefail
PLATFORM_PW="$(cat "$ROSHVYN_PLATFORM_DB_PASSWORD_FILE")"
LITELLM_PW="$(cat "$ROSHVYN_LITELLM_DB_PASSWORD_FILE")"
psql -v ON_ERROR_STOP=1 --username postgres <<SQL
CREATE ROLE roshvyn_platform LOGIN PASSWORD '${PLATFORM_PW}';
CREATE DATABASE roshvyn_platform OWNER roshvyn_platform;
REVOKE ALL ON DATABASE roshvyn_platform FROM PUBLIC;
CREATE ROLE roshvyn_litellm LOGIN PASSWORD '${LITELLM_PW}';
CREATE DATABASE roshvyn_litellm OWNER roshvyn_litellm;
REVOKE ALL ON DATABASE roshvyn_litellm FROM PUBLIC;
SQL
