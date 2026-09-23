#!/usr/bin/env bash
# Hardware guard, run by the "guard" container (started by start.sh). Every ZEHNORA_GUARD_INTERVAL seconds it reads the
# GPU temperature, power and throttle state (nvidia-smi) and the free RAM, and protects the PC:
#   cool-down : GPU >= COOL -> stop the model so the GPU idles; restart it automatically at <= RESUME
#   shut-down : GPU >= STOP, still hot after MAX_COOL seconds, or RAM below MIN_RAM -> stop the model and keep it stopped
# The limits never exceed the card's own reported limits (max operating temp - 5, slowdown temp - 3).
# While a lock file exists (.server-state/guard.lock) start.sh and auto-deploy refuse to start the model;
# after a shut-down, guard-reset.sh clears it once the PC has been checked.
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
STATE="$REPO/.server-state"; LOCK="$STATE/guard.lock"; LOG="$STATE/guard.log"
M=zehnora-model-1
INTERVAL="${ZEHNORA_GUARD_INTERVAL:-10}"
COOL="${ZEHNORA_GUARD_COOLDOWN_C:-80}"
RESUME="${ZEHNORA_GUARD_RESUME_C:-70}"
STOP="${ZEHNORA_GUARD_SHUTDOWN_C:-87}"
MAX_COOL="${ZEHNORA_GUARD_MAX_COOLDOWN_S:-900}"
MIN_RAM="${ZEHNORA_GUARD_MIN_RAM_MIB:-1024}"
MEMINFO="${ZEHNORA_GUARD_MEMINFO:-/proc/meminfo}"
OWNER="${ZEHNORA_HOST_UID:-1000}:${ZEHNORA_HOST_GID:-1000}"

mkdir -p "$STATE" && chown "$OWNER" "$STATE"
log() {
  local line; line="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  echo "$line"; echo "$line" >>"$LOG"; chown "$OWNER" "$LOG" 2>/dev/null || true
}
num() { [[ "$1" =~ ^[0-9]+$ ]]; }

# The card's own limits (degrees C), e.g. "GPU Slowdown Temp : 90 C"
card_limit() { nvidia-smi -q -d TEMPERATURE 2>/dev/null | awk -F: -v k="$1" '$1 ~ k {gsub(/[^0-9]/,"",$2); print $2; exit}'; }
max_op="$(card_limit 'Max Operating Temp')"; slowdown="$(card_limit 'Slowdown Temp')"; shutdown_hw="$(card_limit 'Shutdown Temp')"
if num "$max_op" && [ $((max_op - 5)) -lt "$COOL" ]; then COOL=$((max_op - 5)); fi
if num "$slowdown" && [ $((slowdown - 3)) -lt "$STOP" ]; then STOP=$((slowdown - 3)); fi
[ "$RESUME" -lt "$COOL" ] || RESUME=$((COOL - 10))
[ "$STOP" -gt "$COOL" ] || STOP=$((COOL + 3))
log "guard started: card limits max-operating=${max_op:-?}C slowdown=${slowdown:-?}C shutdown=${shutdown_hw:-?}C; " \
    "cool-down at ${COOL}C, resume at ${RESUME}C, shut-down at ${STOP}C or after ${MAX_COOL}s, min RAM ${MIN_RAM} MiB"

thermal_slowdown() { # field names changed in newer drivers; the temperature check never depends on this
  nvidia-smi --query-gpu=clocks_event_reasons.hw_thermal_slowdown,clocks_event_reasons.sw_thermal_slowdown --format=csv,noheader 2>/dev/null \
    || nvidia-smi --query-gpu=clocks_throttle_reasons.hw_thermal_slowdown,clocks_throttle_reasons.sw_thermal_slowdown --format=csv,noheader 2>/dev/null
}
set_lock() { printf '%s %s\n' "$1" "$2" >"$LOCK"; chown "$OWNER" "$LOCK"; }
running() { [ "$(docker inspect -f '{{.State.Running}}' "$M" 2>/dev/null)" = true ]; }
stop_model() { running && docker stop -t 30 "$M" >/dev/null && log "model stopped"; }

state=normal cool_since=0 last_status=0 nvfail=0
if [ -f "$LOCK" ]; then
  read -r state _ <"$LOCK"
  [ "$state" = cooldown ] && cool_since=$(date +%s)
  log "resuming with existing lock: $(cat "$LOCK")"
fi

while true; do
  now=$(date +%s)
  q="$(nvidia-smi --query-gpu=temperature.gpu,power.draw,utilization.gpu,memory.used --format=csv,noheader,nounits 2>/dev/null)"
  IFS=', ' read -r temp power util vram <<<"$q"
  slow="$(thermal_slowdown)"; IFS=', ' read -r hw_slow sw_slow <<<"$slow"
  ram="$(awk '/MemAvailable/ {print int($2/1024)}' "$MEMINFO")"
  if ! num "${temp:-}"; then
    nvfail=$((nvfail + 1))
    [ $((nvfail % 30)) -eq 1 ] && log "WARNING: cannot read the GPU with nvidia-smi (${nvfail}x): '${q}'"
    sleep "$INTERVAL"; continue
  fi
  nvfail=0
  [ "${hw_slow:-}" = Active ] || [ "${sw_slow:-}" = Active ] && log "card reports thermal slowdown (hw=${hw_slow} sw=${sw_slow}) at ${temp}C"

  case "$state" in
    normal)
      if [ "$temp" -ge "$STOP" ]; then
        set_lock shutdown "GPU ${temp}C >= ${STOP}C at $(date '+%F %T')"; log "SHUT-DOWN: GPU ${temp}C"; stop_model; state=shutdown
      elif [ "$temp" -ge "$COOL" ]; then
        set_lock cooldown "GPU ${temp}C >= ${COOL}C at $(date '+%F %T')"; log "COOL-DOWN: GPU ${temp}C, stopping the model until ${RESUME}C"
        stop_model; state=cooldown; cool_since=$now
      elif num "${ram:-}" && [ "$ram" -lt "$MIN_RAM" ]; then
        set_lock shutdown "RAM available ${ram} MiB < ${MIN_RAM} MiB at $(date '+%F %T')"; log "SHUT-DOWN: RAM available ${ram} MiB"; stop_model; state=shutdown
      fi ;;
    cooldown)
      if [ "$temp" -ge "$STOP" ]; then
        set_lock shutdown "GPU ${temp}C >= ${STOP}C during cool-down at $(date '+%F %T')"; log "SHUT-DOWN: GPU still ${temp}C"; stop_model; state=shutdown
      elif [ "$temp" -le "$RESUME" ]; then
        rm -f "$LOCK"; log "cooled to ${temp}C after $((now - cool_since))s: starting the model"
        docker start "$M" >/dev/null && log "model started" || log "ERROR: could not start the model"; state=normal
      elif [ $((now - cool_since)) -ge "$MAX_COOL" ]; then
        set_lock shutdown "GPU did not cool below ${RESUME}C within ${MAX_COOL}s (now ${temp}C) at $(date '+%F %T')"
        log "SHUT-DOWN: not cooled within ${MAX_COOL}s (${temp}C)"; state=shutdown
      fi ;;
    shutdown)
      if [ ! -f "$LOCK" ]; then log "lock cleared by the owner: guard back to normal"; state=normal; fi ;;
  esac

  if [ $((now - last_status)) -ge 300 ]; then
    log "status: ${state}, GPU ${temp}C ${power}W ${util}% VRAM ${vram} MiB, RAM available ${ram} MiB, model $(running && echo running || echo stopped)"
    last_status=$now
  fi
  sleep "$INTERVAL"
done
