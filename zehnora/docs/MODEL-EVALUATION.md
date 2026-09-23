# Model evaluation

**First GPU run: 2026-09-23** on the university GPU PC (RTX 4070 Ti SUPER 16 GB, Windows + WSL2 + Docker Desktop). The full Gate B/E suites are still open; the results below are the first end-to-end checks.

## GPU PC results (Qwen3.6-35B-A3B UD-Q4_K_XL, llama.cpp server-cuda-v0.4.1, context 65,536)
Path: `test-model.sh` → nginx (127.0.0.1:8080) → platform API (key, credits) → LiteLLM → llama.cpp.

| Check | Result |
|---|---|
| Model load (22.4 GB GGUF, `--fit on`) | healthy in about 25 s after the container started |
| VRAM | 14,110–14,134 MiB of 16,376 MiB; remaining experts in system RAM |
| Coding request, thinking on (`is_valid_ipv4` + 3 pytest tests) | correct code incl. the leading-zero case; 3,013 output tokens (about 9,850 chars of thinking) in 60.1 s = **50.2 tokens/s** |
| Tool call, thinking off | `get_task_count({"project":"alpha"})`, `finish_reason=tool_calls`, 1.9 s |
| GPU utilisation during the run | 36 % (decode is limited by expert reads from system RAM) |
| `health.sh` | all services healthy; `/v1/models` without key 401; `/key/generate` 404; console health 200 |

## Candidates (GPU PC, one loaded at a time)
| | **Default** | Earlier baseline (vLLM engine) |
|---|---|---|
| Repository | `unsloth/Qwen3.6-35B-A3B-GGUF`, file `Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf` | `Qwen/Qwen3-4B-Instruct-2507` |
| Revision (pinned) | `a483e9e6cbd595906af30beda3187c2663a1118c` (file sha256 `707a55a8…4f4450`) | `cdbee75f17c01a7cc42f958dc650907174af0554` |
| Architecture | MoE, 35B total / 3B active, 256 experts, hybrid Gated DeltaNet + Gated Attention | Dense 4B `Qwen3ForCausalLM` |
| Weights | 22.4 GB (Unsloth dynamic 4-bit): attention/shared layers on the GPU, remaining experts in system RAM (`--fit on`) | about 8.0 GB BF16, all on the GPU |
| Engine | `ghcr.io/ggml-org/llama.cpp:server-cuda-v0.4.1` (record image digest at pull) | `vllm/vllm-openai:v0.29.0` |
| Tool calls | llama.cpp `--jinja` with the model's own chat template | `hermes` parser (verify with `--help`) |
| Thinking | on; coding sampling from the model card: temperature 0.6, top-p 0.95, top-k 20, min-p 0; per request `chat_template_kwargs.enable_thinking=false` turns it off | n/a (instruct model) |
| Start config | 1 sequence, 65,536 context (model supports 262,144) | 1 sequence, 4,096 context |
| Published coding score | SWE-bench Verified 73.4% (third-party reported) | n/a |

Why the default changed: the GPU PC has 16 GB VRAM and 64 GB RAM. A MoE model with only 3B active parameters runs at usable speed with its experts partly in RAM, and it is far stronger at coding than a 4B dense model. Dense 27B models (Qwen3.6/3.8-27B) do not fit in 16 GB even at 4-bit.

### Mac check of the thinking path (development, NOT a GPU result)
With `ZEHNORA_DEV_REASONING=on` (Qwen3.5-4B, llama.cpp b9960, 2026-09-23): the full platform path forwards `reasoning_content` separately from `content`, tool calls work with thinking on (3/3 tool checks), and `chat_template_kwargs.enable_thinking=false` passes through LiteLLM and the platform (answer in 0.7 s instead of 14 s). The SDK suite passes **10/10 with `--no-thinking`**; with thinking on, the three checks that use `max_tokens` 80–200 return empty content because thinking consumes the budget (expected; the server's default output limit is 8,192).

To record for each run: exact revision, tokenizer and chat template source, parser, dtype, vLLM image digest, loaded VRAM (`nvidia-smi`), time to first token, output tokens/s, and pass counts per test.

## Evaluation plan (repeat each several times; report actual pass counts)
1. Automatic tool choice (no forced tools) on file tasks.
2. Read → edit (`apply_patch`) → verify.
3. Windows shell use (PowerShell and CMD) through the workspace connector (run on Windows).
4. Fresh full-stack ABC project (React + FastAPI + SQLite): create, install, test, run, browser check, follow-up change, restart persistence (Gate E).
5. Multi-step Google operations (after OAuth setup).
6. Search + page reading with real results.
7. Context continuation across several turns at 4K/8K.

## Development measurements on the Mac (NOT GPU results)
Model: Qwen3.5-4B Q4_K_M GGUF (unsloth), llama.cpp b9960, Intel i7-9750H CPU, ctx 8192. Measured median generation about 8 tokens/s and prompt processing about 31 tokens/s (earlier experiment).

| Test (through the full Zehnora platform path) | Result |
|---|---|
| SDK compatibility suite (`test-public-api.py`): models, text, stream, auto tool call + continuation, streamed tool call, LangChain invoke/stream/bind_tools, bad key | **10/10** |
| Desktop agent through LibreChat: create folder + file, list it (3 tool calls) | **1/1**, 165 s |

The earlier LibreChat experiment with the same 4B model passed 4/4 T1, 4/4 T2 (unseen value), 3/3 T3 (append), 3/3 T4 (static site), 3/3 T5 (follow-up). See `~/Desktop/LibreChat-Mac-Experiment/RESULTS.md`. That was a simpler file-only task set, not the ABC full-stack gate.
