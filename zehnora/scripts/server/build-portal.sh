#!/usr/bin/env bash
# Install Node 24.16.0 into ~/.local/node (checksum verified, once) and build the portal into zehnora/portal/dist.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NODE_VERSION=v24.16.0
NODE_DIR="$HOME/.local/node"
say() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

if [ "$("$NODE_DIR/bin/node" -v 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  tarball="node-$NODE_VERSION-linux-x64.tar.xz"
  say "downloading Node $NODE_VERSION"
  curl -fsSL -o "$tmp/$tarball" "https://nodejs.org/dist/$NODE_VERSION/$tarball"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
  (cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c -)
  rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
  tar xJf "$tmp/$tarball" -C "$NODE_DIR" --strip-components=1
  grep -q '.local/node/bin' "$HOME/.bashrc" 2>/dev/null || echo 'export PATH="$HOME/.local/node/bin:$PATH"' >>"$HOME/.bashrc"
fi
export PATH="$NODE_DIR/bin:$PATH"
say "node $(node -v), npm $(npm -v)"

cd "$REPO/zehnora/portal"
say "installing portal dependencies"; npm ci --no-audit --no-fund
say "building portal"; npm run build
[ -f dist/index.html ] || { say "ERROR: build did not produce dist/index.html"; exit 1; }
say "portal built: $REPO/zehnora/portal/dist"
