#!/usr/bin/env bash
# Measured report of the running model: hardware, llama.cpp's own GPU/CPU placement from its load log, memory, disk,
# and a fixed benchmark (prompt processing + generation) with GPU/CPU sampled every second. Prints no secrets.
# Output is also saved to ~/zehnora-reports/model-report-<timestamp>.txt
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
set +e  # a report keeps going when one probe finds nothing
M=zehnora-model-1
[ "$(docker inspect -f '{{.State.Health.Status}}' "$M" 2>/dev/null)" = healthy ] || die "model container is not healthy"
OUT_DIR="$HOME/zehnora-reports"; mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/model-report-$(date +%Y%m%d-%H%M%S).txt"
TMP="$(mktemp -d)"; trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$TMP"' EXIT

report() {
  echo "== Zehnora model report, $(date '+%Y-%m-%d %H:%M:%S %Z') =="
  echo "model file : $MODEL_PATH"
  echo "file size  : $(stat -c %s "$MODEL_PATH") bytes ($(du -h "$MODEL_PATH" | cut -f1))"
  echo "engine     : $ZEHNORA_ENGINE, image $(docker inspect -f '{{.Config.Image}}' "$M")"
  echo "settings   : ctx ${ZEHNORA_MAX_MODEL_LEN:-} parallel ${ZEHNORA_MAX_NUM_SEQS:-} reasoning ${ZEHNORA_REASONING:-}"

  echo; echo "== Hardware =="
  nvidia-smi --query-gpu=name,driver_version,memory.total,power.limit,temperature.gpu --format=csv,noheader | sed 's/^/gpu        : /'
  echo "cpu        : $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs), $(nproc) logical cores visible to WSL"
  echo "ram (WSL)  : $(free -b | awk '/Mem:/{printf "%.1f GiB total, %.1f GiB used, %.1f GiB available", $2/2^30, $3/2^30, $7/2^30}')"
  echo "disk       : $(df -h --output=size,used,avail "$ZEHNORA_MODEL_DIR" | tail -1 | awk '{print $1" total, "$2" used, "$3" free"}') on the model disk"

  echo; echo "== Placement reported by llama.cpp at load (GPU = CUDA0, CPU = CPU/CPU_Mapped) =="
  docker logs "$M" 2>&1 | grep -E 'fit|offload|buffer size|n_ctx|n_cpu_moe|cpu_moe|KV|model params|file size|file type|CUDA0 *:|device' \
    | grep -v -E 'GET /health|POST' | tail -n 40

  echo; echo "== Memory right now =="
  nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu,power.draw --format=csv,noheader | sed 's/^/gpu        : /'
  docker stats --no-stream --format 'container  : {{.Name}}  cpu {{.CPUPerc}}  mem {{.MemUsage}}' "$M"
  echo "disk usage : model dir $(du -sh "$ZEHNORA_MODEL_DIR" | cut -f1); docker images $(docker system df --format '{{.Type}} {{.Size}}' | awk '/Images/{print $2}')"
}

sample() { # background sampler: gpu util %, power W, vram MiB, model container cpu %
  while true; do
    g="$(nvidia-smi --query-gpu=utilization.gpu,power.draw,memory.used --format=csv,noheader,nounits | tr -d ' ')"
    c="$(docker stats --no-stream --format '{{.CPUPerc}}' "$M" | tr -d '%')"
    echo "$g,$c" >>"$1"
  done
}

bench() { # label json-body
  : >"$TMP/samples"; sample "$TMP/samples" & local sp=$!
  docker exec -i "$M" sh -c 'curl -s --max-time 900 http://127.0.0.1:8000/completion -H "Authorization: Bearer $(cat /run/secrets/vllm_api_key)" -H "Content-Type: application/json" -d @-' \
    <<<"$2" >"$TMP/resp.json"
  kill "$sp" 2>/dev/null; wait "$sp" 2>/dev/null
  python3 - "$1" "$TMP/resp.json" "$TMP/samples" <<'PY'
import json, sys
label, resp, samples = sys.argv[1:]
t = json.load(open(resp)).get("timings") or sys.exit(f"[{label}] no timings in response: {open(resp).read()[:300]}")
rows = [list(map(float, l.split(","))) for l in open(samples) if l.count(",") == 3 and "N/A" not in l]
print(f"[{label}] prompt {t['prompt_n']} tokens in {t['prompt_ms']/1000:.2f}s = {t['prompt_per_second']:.1f} tok/s; "
      f"generated {t['predicted_n']} tokens in {t['predicted_ms']/1000:.2f}s = {t['predicted_per_second']:.1f} tok/s")
if rows:
    col = lambda i: [r[i] for r in rows]
    for name, i, unit in (("gpu util", 0, "%"), ("gpu power", 1, " W"), ("vram", 2, " MiB"), ("model cpu", 3, "%")):
        v = col(i); print(f"    {name:9s} avg {sum(v)/len(v):7.1f}{unit}   max {max(v):7.1f}{unit}   ({len(v)} samples)")
PY
}

{
  report
  echo; echo "== Benchmark (llama.cpp /completion, fixed prompts, no thinking template) =="
  bench "generation 512 tokens" '{"prompt":"Write a detailed Python tutorial about data structures.\n","n_predict":512,"ignore_eos":true,"temperature":0.6,"cache_prompt":false}'
  long_prompt="$(python3 -c "print(' '.join(['The quick brown fox jumps over the lazy dog near the river bank.']*700))")"
  bench "long prompt ~9k tokens" "{\"prompt\":\"$long_prompt\",\"n_predict\":64,\"ignore_eos\":true,\"cache_prompt\":false}"
  echo; echo "== After benchmark =="
  nvidia-smi --query-gpu=memory.used,memory.total,temperature.gpu --format=csv,noheader | sed 's/^/gpu        : /'
  docker stats --no-stream --format 'container  : {{.Name}}  cpu {{.CPUPerc}}  mem {{.MemUsage}}' "$M"
} 2>&1 | tee "$OUT"
say "saved: $OUT"
