#!/usr/bin/env bash
# Download the configured model at its PINNED revision to ZEHNORA_MODEL_DIR (outside git), then verify it and
# record SHA-256 sums. With ZEHNORA_MODEL_FILE set (llamacpp) only that GGUF file is fetched and must match
# ZEHNORA_MODEL_SHA256; otherwise (vllm) the safetensors snapshot is fetched. GPU PC only - never on the Mac.
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
: "${ZEHNORA_MODEL_REPO:?}" "${ZEHNORA_MODEL_REVISION:?}" "${ZEHNORA_MODEL_SUBDIR:?}" "${ZEHNORA_MODEL_DIR:?}"
[[ "$ZEHNORA_MODEL_REVISION" =~ ^[0-9a-f]{40}$ ]] || die "ZEHNORA_MODEL_REVISION must be a full 40-character commit sha"
DEST="$ZEHNORA_MODEL_DIR/$ZEHNORA_MODEL_SUBDIR"
mkdir -p "$DEST"
command -v uvx >/dev/null || die "uv is required (https://docs.astral.sh/uv/)"
hf() { uvx --from 'huggingface_hub[hf_xet]==1.*' hf download "$ZEHNORA_MODEL_REPO" --revision "$ZEHNORA_MODEL_REVISION" --local-dir "$DEST" "$@"; }

if [ -n "${ZEHNORA_MODEL_FILE:-}" ]; then
  [[ "${ZEHNORA_MODEL_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] || die "ZEHNORA_MODEL_SHA256 must be the file's 64-character sha256"
  free_gb=$(df -BG --output=avail "$DEST" | tail -1 | tr -dc 0-9)
  [ "$free_gb" -ge 30 ] || die "only ${free_gb} GB free at $DEST; need about 30 GB"
  say "downloading $ZEHNORA_MODEL_REPO/$ZEHNORA_MODEL_FILE @ ${ZEHNORA_MODEL_REVISION:0:12} -> $DEST (resumable)"
  hf "$ZEHNORA_MODEL_FILE"
  say "verifying sha256 (takes a minute)"
  echo "$ZEHNORA_MODEL_SHA256  $ZEHNORA_MODEL_FILE" | (cd "$DEST" && sha256sum -c -) || die "checksum mismatch: delete $DEST/$ZEHNORA_MODEL_FILE and download again"
  ( cd "$DEST" && sha256sum "$ZEHNORA_MODEL_FILE" >SHA256SUMS )
else
  say "downloading $ZEHNORA_MODEL_REPO @ $ZEHNORA_MODEL_REVISION -> $DEST"
  hf --exclude '*.gguf' '*.onnx' 'original/*'
  for f in config.json tokenizer_config.json; do [ -f "$DEST/$f" ] || die "missing $f in download"; done
  ls "$DEST"/*.safetensors >/dev/null 2>&1 || die "no .safetensors weights found"
  ( cd "$DEST" && find . -type f ! -name 'SHA256SUMS' ! -path './.cache/*' -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS )
fi

cat >"$DEST/ZEHNORA-PROVENANCE.txt" <<TXT
repository: $ZEHNORA_MODEL_REPO
revision:   $ZEHNORA_MODEL_REVISION
file:       ${ZEHNORA_MODEL_FILE:-(full snapshot)}
downloaded: $(date -u +%Y-%m-%dT%H:%M:%SZ)
host:       $(hostname)
files:      see SHA256SUMS
TXT
du -sh "$DEST"
say "done: $MODEL_PATH"
