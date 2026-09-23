#!/usr/bin/env bash
# Local end-to-end model check through nginx (no browser, no tunnel needed):
#   test-model.sh you@example.com
# Grants demo credits to that account once, creates an API key (kept in .server-secrets/test-api-key, never printed),
# then sends a coding request (thinking on) and a tool-call request (thinking off) and reports speed.
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
[ -n "${1:-}" ] || die "usage: test-model.sh you@example.com   (an existing portal/admin account)"
API=zehnora-platform-api-1
KEYF="$SECRETS/test-api-key"
if [ ! -s "$KEYF" ]; then
  docker exec "$API" python -m app.cli grant-credits --email "$1" --credits 100 --reason "server model test"
  (umask 077; docker exec "$API" python -m app.cli create-key --email "$1" --name "server model test" 2>/dev/null >"$KEYF")
  [ -s "$KEYF" ] || die "could not create a test key"
  say "test key created and stored in $KEYF"
fi

ask() { # label json-body: send one request, then print timing, tool calls and the answer
  local out t0; out="$(mktemp)"; t0=$(date +%s.%N)
  curl -s --max-time 900 http://127.0.0.1:8080/v1/chat/completions -H "Host: api.$OWNER_DOMAIN" \
    -H "Authorization: Bearer $(cat "$KEYF")" -H 'Content-Type: application/json' -d "$2" >"$out"
  python3 - "$1" "$t0" "$out" <<'PY'
import json, sys, time
label, t0, path = sys.argv[1], float(sys.argv[2]), sys.argv[3]
d = json.load(open(path))
if "error" in d:
    sys.exit(f"[{label}] ERROR: {d['error']}")
m, u, dt = d["choices"][0]["message"], d["usage"], time.time() - t0
print(f"[{label}] {dt:.1f}s, {u['completion_tokens']} output tokens, {u['completion_tokens'] / dt:.1f} tokens/s, "
      f"finish={d['choices'][0]['finish_reason']}")
if m.get("reasoning_content"):
    print(f"  thinking: {len(m['reasoning_content'])} chars")
for c in m.get("tool_calls") or []:
    print(f"  tool call: {c['function']['name']}({c['function']['arguments']})")
if m.get("content"):
    print("  answer:\n" + "\n".join("    " + line for line in m["content"].strip().splitlines()[:40]))
PY
  rm -f "$out"
}

say "1/2 coding request (thinking on)"
ask coding '{"model":"zehnora-coder","max_tokens":6000,"messages":[{"role":"user","content":"Write a Python function is_valid_ipv4(s) with a short docstring, plus three pytest tests. Code only."}]}'

say "2/2 tool call (thinking off)"
ask tools '{"model":"zehnora-coder","max_tokens":400,"chat_template_kwargs":{"enable_thinking":false},
  "tools":[{"type":"function","function":{"name":"get_task_count","description":"Return how many tasks exist in a project.",
    "parameters":{"type":"object","properties":{"project":{"type":"string"}},"required":["project"]}}}],
  "messages":[{"role":"user","content":"How many tasks are in project alpha? Use the tool."}]}'
docker exec zehnora-model-1 nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu --format=csv,noheader | sed 's/^/  gpu: /' || true
