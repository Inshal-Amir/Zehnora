# Model evaluation

**No GPU evaluation has been run yet.** Gate B/E acceptance happens only on the university GPU PC with the deployed model. The results below are development measurements on the Mac and are labelled as such.

## Candidates (GPU PC, one loaded at a time)
| | Baseline | Challenger |
|---|---|---|
| Repository | `Qwen/Qwen3-4B-Instruct-2507` | `Qwen/Qwen3.5-4B` |
| Revision (pinned) | `cdbee75f17c01a7cc42f958dc650907174af0554` | `851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a` |
| Architecture | `Qwen3ForCausalLM` | `Qwen3_5ForConditionalGeneration` (has a vision encoder; run text-only) |
| BF16 weights | about 8.0 GB | about 9.3 GB (incl. vision) |
| vLLM | `vllm/vllm-openai:v0.29.0` (record image digest at pull) | same |
| Tool parser | `hermes` (verify with `--help`) | `qwen3_coder` per model card (verify) |
| Start config | 1 sequence, 4,096 context; raise to 8K/16K only after measuring memory | same |

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

| Test (through the full Roshvyn platform path) | Result |
|---|---|
| SDK compatibility suite (`test-public-api.py`): models, text, stream, auto tool call + continuation, streamed tool call, LangChain invoke/stream/bind_tools, bad key | **10/10** |
| Desktop agent through LibreChat: create folder + file, list it (3 tool calls) | **1/1**, 165 s |

The earlier LibreChat experiment with the same 4B model passed 4/4 T1, 4/4 T2 (unseen value), 3/3 T3 (append), 3/3 T4 (static site), 3/3 T5 (follow-up). See `~/Desktop/LibreChat-Mac-Experiment/RESULTS.md`. That was a simpler file-only task set, not the ABC full-stack gate.
