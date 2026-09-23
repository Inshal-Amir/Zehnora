#!/usr/bin/env bash
# Exact GPU/CPU placement of the model as llama.cpp decides it. llama.cpp prints its load details (buffer sizes per
# device, --fit decisions, tensor overrides) only at debug verbosity, so this reloads the model once with -lv 4,
# saves that part of the log, then reloads it with the normal settings. The API is unavailable for about a minute.
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
[ "$ZEHNORA_ENGINE" = llamacpp ] || die "only for the llamacpp engine"
M=zehnora-model-1
OUT_DIR="$HOME/zehnora-reports"; mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/model-placement-$(date +%Y%m%d-%H%M%S).txt"
normal_args="${ZEHNORA_LLAMACPP_EXTRA_ARGS:-}"

wait_model() {
  local i=0
  until [ "$(docker inspect -f '{{.State.Health.Status}}' "$M" 2>/dev/null)" = healthy ]; do
    i=$((i+1)); [ $i -ge 120 ] && die "model not healthy (docker logs $M)"; sleep 2; done
}
restore() { say "reloading the model with the normal settings"; ZEHNORA_LLAMACPP_EXTRA_ARGS="$normal_args" dc up -d model >/dev/null 2>&1; wait_model; say "model back to normal"; }
trap restore EXIT

say "reloading the model with debug load logging (API down for about a minute)"
ZEHNORA_LLAMACPP_EXTRA_ARGS="$normal_args -lv 4" dc up -d model >/dev/null 2>&1
wait_model
sleep 2
{
  echo "== llama.cpp load details, $(date '+%Y-%m-%d %H:%M:%S %Z') =="
  echo "model: $MODEL_PATH"
  docker logs "$M" 2>&1 | sed -n '1,/listening on/p' \
    | grep -i -E 'fit|offload|buffer|override|CUDA|CPU|device|n_ctx|kv|memory|mmap|layer|model params|file size|file type|n_gpu|n_cpu|moe|thread' \
    | grep -v -E 'tensor .* buffer type overridden' | cut -c1-220
  echo
  echo "== tensors placed on CPU by --fit (count by tensor kind) =="
  docker logs "$M" 2>&1 | sed -n '1,/listening on/p' | grep -o -E 'tensor [^ ]+ .*(overridden|override)[^,]*' \
    | sed -E 's/blk\.[0-9]+\.//; s/tensor ([^ ]+).*/\1/' | sort | uniq -c
  echo
  echo "== GPU and container memory with this load =="
  nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader
  docker stats --no-stream --format '{{.Name}} mem {{.MemUsage}}' "$M"
} | tee "$OUT"
say "saved: $OUT"
