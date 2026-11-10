# Gate J public demo LIVE AI DRY RUN

**Endpoint (OCI):** `POST https://nio-api-hack26.duckdns.org/v1/gate-j/demo-decide`  
**Status:** `GET /v1/gate-j/demo-status` (public)  
**Auth:** `x-api-key` required for `demo-decide` (Vercel BFF injects server key)

## Contract

Request body is ignored for safety-critical fields. Server forces:

| Field | Forced value |
|-------|----------------|
| `portfolio_id` | `i-a-a4e7` |
| `claimed_owner` | `nio-i-a4e7-a-owner.testnet` |
| `use_llm` | `true` |
| `dry_run` | `true` |
| `allow_execute` | `false` |
| `may_sign` | `false` |

Rejected with `403 DEMO_FORBIDDEN_FIELD` if any of these are `true`:  
`allow_execute`, `confirm_funded_trade`, `acceptance_override`, `gate_k_execute`, `may_sign`, `withdraw`, `withdrawal`, `set_policy`, `mutate_policy`, `operator_confirm`.

Client mandate / fixture escapes are never accepted. Mandate is hydrated on-chain only.

Response always includes: `demo: true`, `DRY_RUN: true`, `no_signing: true`, `may_sign: false`, `forced: {…}`, genuine Researcher / Strategist / Fitter / Critic outcomes (including `NO_TRADE`, `ECONOMIC_NOT_VIABLE`, critic `REJECT` / `ABSTAIN`).

## Limits (persistent under `GATE_I_DATA_DIR/gate-j-demo-quota.json`)

| Limit | Default |
|-------|---------|
| Per-client daily calls | 3 |
| Global daily calls | 40 |
| OpenRouter spend cap (daily, estimated) | $2.00 |
| Min interval per client | 15s |
| Single-flight concurrency | 1 (global) |
| Request timeout | 90s |
| Kill switch | `GATE_J_DEMO_KILL_SWITCH=1` → `503` |

Fail-closed if quota file unreadable/unwritable (`DEMO_QUOTA_UNAVAILABLE`).

## Gate K

Must remain off: `GATE_K_ALLOW_SIGN=0`, `GATE_K_AUTONOMOUS_LOOP=0`, `GATE_K_ACCEPTANCE=0`.

## Chat 2 enable checklist

1. OCI demo-decide verified (this doc).
2. Redeploy Vercel BFF with `/gate-j/demo-decide` allowlisted (rewrites live `use_llm` → demo-decide).
3. Set `NIO_PUBLIC_LIVE_AI=true` and `VITE_PUBLIC_LIVE_AI=true`.
4. Do **not** enable Gate K signing or acceptance override.
