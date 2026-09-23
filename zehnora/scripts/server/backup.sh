#!/usr/bin/env bash
# Back up both databases (custom-format pg_dump) + non-secret config metadata into <repo>/../zehnora-backups.
# Encrypt with: age -r <recipient> file > file.age (or gpg -c). Restore (isolated test DB first!):
#   docker exec -i zehnora-postgres-1 pg_restore -U postgres -d <db> --clean --if-exists < file.dump
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
OUT="${ZEHNORA_BACKUP_DIR:-$REPO/../zehnora-backups}/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT" && chmod 700 "$OUT"
for db in zehnora_platform zehnora_litellm; do
  docker exec zehnora-postgres-1 pg_dump -U postgres -Fc "$db" >"$OUT/$db.dump"
done
git -C "$REPO" rev-parse HEAD >"$OUT/repo-commit.txt"
grep -v -i -E 'password|secret|key|token' "$SECRETS/server.env" >"$OUT/server.env.public" || true
sha256sum "$OUT"/* >"$OUT/SHA256SUMS"
say "backup written to $OUT (encrypt before copying off the PC)"
