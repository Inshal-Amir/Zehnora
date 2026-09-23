#!/usr/bin/env bash
# Download the configured model snapshot at its PINNED revision to ROSHVYN_MODEL_DIR (outside git), then
# verify required files and record SHA-256 sums. GPU PC only - never run this on the development Mac.
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
: "${ROSHVYN_MODEL_REPO:?}" "${ROSHVYN_MODEL_REVISION:?}" "${ROSHVYN_MODEL_SUBDIR:?}" "${ROSHVYN_MODEL_DIR:?}"
[[ "$ROSHVYN_MODEL_REVISION" =~ ^[0-9a-f]{40}$ ]] || die "ROSHVYN_MODEL_REVISION must be a full 40-character commit sha"
DEST="$ROSHVYN_MODEL_DIR/$ROSHVYN_MODEL_SUBDIR"
mkdir -p "$DEST"
command -v uvx >/dev/null || die "uv is required (https://docs.astral.sh/uv/)"
say "downloading $ROSHVYN_MODEL_REPO @ $ROSHVYN_MODEL_REVISION -> $DEST"
uvx --from 'huggingface_hub==1.*' hf download "$ROSHVYN_MODEL_REPO" --revision "$ROSHVYN_MODEL_REVISION" --local-dir "$DEST" \
  --exclude '*.gguf' '*.onnx' 'original/*'
for f in config.json tokenizer_config.json; do [ -f "$DEST/$f" ] || die "missing $f in download"; done
ls "$DEST"/*.safetensors >/dev/null 2>&1 || die "no .safetensors weights found"
( cd "$DEST" && find . -type f ! -name 'SHA256SUMS' ! -path './.cache/*' -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS )
cat >"$DEST/ROSHVYN-PROVENANCE.txt" <<TXT
repository: $ROSHVYN_MODEL_REPO
revision:   $ROSHVYN_MODEL_REVISION
downloaded: $(date -u +%Y-%m-%dT%H:%M:%SZ)
host:       $(hostname)
files:      see SHA256SUMS
TXT
du -sh "$DEST"
say "done. Chat template: $(python3 -c "import json;print('present' if json.load(open('$DEST/tokenizer_config.json')).get('chat_template') or __import__('os').path.exists('$DEST/chat_template.jinja') else 'MISSING')")"
