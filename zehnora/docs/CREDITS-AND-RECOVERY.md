# Credits, reservations, settlement and recovery

Credits are **demonstration units assigned by an administrator**. They are not money, not a payment-processor balance, and not measured GPU electricity cost.

## Units and rates
- Integers only. **1 displayed credit = 1,000 units.**
- Initial demo rates (model_rates version 1): **input 1 unit/token, output 2 units/token**. Example: 100 input + 200 output tokens = 500 units = 0.5 credits. These are our chosen demo rates, not benchmarks or market prices.
- Rates are versioned. Each request stores the rate version and the rates it used (`inference_requests.rate_version/input_rate/output_rate`).

## Wallet invariants (enforced by PostgreSQL)
- `balance_units >= 0`, `reserved_units >= 0`, `reserved_units <= balance_units` (so available = balance − reserved is never negative).
- `credit_ledger` is **append-only**: a trigger blocks UPDATE, DELETE and TRUNCATE. Every grant, adjustment and usage debit has an actor, a reason and a unique `operation_id`.

## Admission (before any model call)
1. Validate key, account status, permitted model, and request shape; normalise output limits (`max_tokens`/`max_completion_tokens`; conflicting values are rejected; values above the model's tested maximum are rejected; if absent, the model's default output limit is applied and **forwarded upstream**, so it is enforced).
2. **Upper bound for input tokens without a tokenizer:** byte-level BPE (the Qwen family) emits tokens that each decode to at least one byte, so text tokens ≤ UTF-8 bytes of the serialised messages and tool definitions. Add a fixed chat-template overhead (1,024 tokens) and 16 tokens per message; cap at the model's enforced context limit. This deliberately over-reserves, and never under-reserves based on a character-count guess.
3. Reservation = input bound × input rate + enforced max output × output rate.
4. In one transaction: `SELECT … FROM wallets WHERE user_id = … FOR UPDATE`, check available ≥ reservation, add to `reserved_units`, insert the `inference_requests` row (state `reserved`). All keys of an account share this row lock, so concurrent requests cannot overspend. **Verified:** two simultaneous requests that each fit but jointly exceed the wallet → exactly one admitted, one 402.
5. Insufficient credits → 402 before generation. Billing database down → 503, fail closed (verified: no upstream call happened).

## Settlement
- State `reserved` → `dispatched` just before the upstream call.
- Settlement reads the authoritative usage returned by the gateway (`usage.prompt_tokens/completion_tokens`, streaming: the final usage chunk), then in one transaction: lock request + wallet, charge = in × rate + out × rate, balance −= charge, reserved −= reservation, append a `usage` ledger row with `operation_id = usage:<request id>`, state → `settled`.
- **Idempotent:** settlement only touches requests still open (`reserved/dispatched/pending_reconciliation`), and the ledger operation id is unique. A duplicate callback or reconciliation cannot debit twice (tested).
- Safety cap: if usage ever exceeded the reservation (it should not), the charge is capped at what the account can cover and the shortfall is noted on the request, never pushing the balance negative.

## Failure cases
| Case | Result |
|---|---|
| Gateway unreachable (no connection) | Release whole reservation; no generation happened |
| Upstream error status before any output (e.g. 500) | Release; `error_code=upstream_error` (tested) |
| Non-stream response without usage | `pending_reconciliation`, reservation kept |
| Stream completed with usage | Settle actual usage (tested) |
| **Stream truncated upstream** | LiteLLM 1.102.0 closes such a stream with a synthetic `finish_reason` and a **tokenizer-counted usage chunk** of the tokens actually delivered. The platform cannot distinguish this from a normal finish through LiteLLM, so **partial generations are charged the gateway-reported delivered usage**: never free, never the whole reservation. Documented limitation. |
| Stream ends with no `finish_reason` and/or no usage (visible truncation) | `pending_reconciliation` with the gateway's unverified usage recorded in the note |
| Client disconnects mid-stream | The upstream is read on independently for up to 20 s to obtain final usage, then settled; otherwise the upstream is cancelled and the request becomes `pending_reconciliation` (tested: settles with drained usage) |
| Platform restarts | Startup recovery: `reserved` (never dispatched) → released; `dispatched` (usage unknown) → `pending_reconciliation`, reservation kept. Time alone never marks a request free (tested) |

## Reconciliation
Admins list `pending_reconciliation` requests (portal: Models & requests) and resolve each one with usage verified from gateway/model logs (`settle`, charged exactly once) or `release` with a reason. Every resolution is written to `audit_events`.

LiteLLM also tracks its own spend for diagnostics. It is **not** deducted from the wallet; the platform ledger is the only authoritative customer balance.
