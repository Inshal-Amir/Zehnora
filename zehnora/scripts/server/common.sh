# Shared helpers for server scripts (run inside WSL on the GPU PC).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SECRETS="$REPO/.server-secrets"
COMPOSE_DIR="$REPO/zehnora/infra/server"
say() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { say "ERROR: $*"; exit 1; }
[ -f "$SECRETS/server.env" ] || die "missing $SECRETS/server.env (copy zehnora/infra/server/server.env.example and fill it in)"
set -a; . "$SECRETS/server.env"; set +a
dc() { docker compose --project-directory "$COMPOSE_DIR" -f "$COMPOSE_DIR/compose.yaml" --env-file "$SECRETS/server.env" "$@"; }
