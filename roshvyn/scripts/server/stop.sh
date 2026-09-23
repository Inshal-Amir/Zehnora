#!/usr/bin/env bash
# Stop Roshvyn server containers. Keeps volumes (database), model files and backups. Never uses `down -v`.
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
dc --profile tunnel stop
say "stopped (data kept). Restart with start.sh"
