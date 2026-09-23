#!/usr/bin/env bash
# Local readiness checks; prints no secrets.
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
fail=0
for s in postgres model litellm platform-api nginx; do
  st="$(docker inspect -f '{{.State.Health.Status}}' "zehnora-$s-1" 2>/dev/null || docker inspect -f '{{.State.Status}}' "zehnora-$s-1" 2>/dev/null || echo missing)"
  printf '  %-13s %s\n' "$s" "$st"; case "$st" in healthy|running) ;; *) fail=1 ;; esac
done
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: api.$OWNER_DOMAIN" http://127.0.0.1:8080/v1/models); echo "  api /v1/models without key -> $code (expect 401)"; [ "$code" = 401 ] || fail=1
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: api.$OWNER_DOMAIN" http://127.0.0.1:8080/key/generate); echo "  gateway admin path blocked -> $code (expect 404)"; [ "$code" = 404 ] || fail=1
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: console.$OWNER_DOMAIN" http://127.0.0.1:8080/platform/v1/health); echo "  console health -> $code (expect 200)"; [ "$code" = 200 ] || fail=1
docker exec zehnora-model-1 nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader 2>/dev/null | sed 's/^/  gpu memory: /' || true
exit $fail
