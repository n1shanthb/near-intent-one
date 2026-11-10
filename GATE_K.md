# Gate K — AI-Directed Testnet Trading

**Status: PASS (acceptance)** — one live OpenRouter-directed Sepolia trade signed, settled, and independently reconciled on `i-a-a4e7` (24.45 USDC). Fitter/Critic had vetoed economics; operator acceptance override recorded in evidence. See `evidence/live/gate-k-first-trade.json`.

## What Gate K implements

Connects the Gate J OpenRouter multi-agent decision pipeline to the proven Gate I execution path:

Real market → Gemini Researcher → Claude Strategist → Deterministic Mandate Fitter → GPT Risk Critic → Deterministic Policy Guard → Fresh Tidepool quote → On-chain mandate revalidation → NEAR MPC (`propose_quoted_evm_transfer` → `request_signature`) → Sepolia broadcast (reconciler) → NEAR Intents → Independent reconciler.

LLMs only propose/review. Only deterministic enforcement may progress toward signing.

### Modes

| Mode | Behavior |
|------|----------|
| `AI_DRY_RUN` (default) | Full AI path; never signs |
| `AI_TESTNET_EXECUTION` | Real signing; requires API auth + operator confirm flags + `GATE_K_ALLOW_SIGN=1` |
| `AI_AUTONOMOUS` | Unattended loop; requires on-chain `autonomous_trading=true` + `GATE_K_AUTONOMOUS_LOOP=1`; never auto-starts |

### Safety overlay (first test)

On top of the owner mandate (never instead of):

- Portfolio `i-a-a4e7` only
- USDC → wNEAR, Sepolia only
- Max **26 USDC** per trade (operator-authorized first-test overlay)
- Max one AI-directed trade until `GATE_K_ALLOW_MULTI=1`
- Single-flight; no auto-retry that creates another trade
- Demo Ledger portfolios (`nio-c-*`) forbidden

### Autonomous trading (owner-controlled)

Contract storage key `gate_k:autonomous_trading` (no Borsh migration):

- `set_autonomous_trading(enabled)` — **owner only**
- `get_autonomous_trading()` / included in `get_gate_j_mandate`
- Default **OFF**

## Implemented vs proven on-chain

| Item | Status |
|------|--------|
| Gate K pipeline + safety + economics buffer | Implemented (unit tested) |
| Reuse Gate I propose/sign path | Implemented (code reuse; not yet live for AI) |
| API `/gate-k/*` routes | Implemented |
| Autonomous loop (gated) | Implemented; not started |
| Policy WASM `set/get_autonomous_trading` | Code present — **deploy/upgrade required** |
| First AI-directed Sepolia trade | **Not executed** — awaiting operator approval |
| Independent reconcile of AI trade | **Not proven** |

## Tests

```bash
node --test packages/gate-k/gate-k.test.mjs
pnpm test:gate-j   # preserved
```

Coverage includes: NO_TRADE, fitter reject, critic veto/abstain, thin edge, stale market, epoch/revocation before sign, wrong owner, unauthenticated exec, single-flight, max trades, autonomous disabled, restart pending recovery.

## Owner authorization steps

1. Owner uses the supported wallet/Ledger path to approve the on-chain mandate (`set_policy` / existing Gate I owner flows).  
   **Not** a browser `claimed_owner` string, API key, or LLM response.
2. Mandate must bound: assets/networks, per-trade & daily limits, max pending exposure, slippage, expiration, revoke/pause.
3. Optional later: owner calls `set_autonomous_trading(true)` on the policy contract (default remains false).
4. Operator confirms the first 1 USDC AI test separately (below).

## Prepare first 1 USDC test (preview only — no broadcast)

```bash
# Dry-run with fixtures / optional live LLM
node scripts/gate-k-prepare.mjs
node scripts/gate-k-prepare.mjs --live-llm

# Or against a running API
node scripts/gate-k-prepare.mjs --api http://127.0.0.1:8787/v1 --live-llm
```

Writes `evidence/live/gate-k-prepare-preview.json` with the exact preview (max spend, mandate epoch, economics).

## First live execution (only after your explicit approval)

**Do not run until you authorize.**

1. Confirm reconciler is healthy (`GET /v1/health`).
2. Upgrade policy WASM if `get_autonomous_trading` / `get_gate_j_mandate.autonomous_trading` missing.
3. Set env for the API process: `GATE_K_ALLOW_SIGN=1` (signing gate).
4. POST with API key:

```http
POST /v1/gate-k/decide
x-api-key: <GATE_I_API_KEY>
{
  "portfolio_id": "i-a-a4e7",
  "use_llm": true,
  "mode": "AI_TESTNET_EXECUTION",
  "operator_confirm": true,
  "confirm_first_ai_trade": true,
  "confirm_max_spend_usdc": 1
}
```

At most one qualifying trade. Evidence lands in `evidence/live/gate-k-last-decision.json` + store executions. Reconciler must finish Sepolia/Intents; do not mark SUCCESS early.

## Autonomous loop (after first proof)

Requires: reconciled first AI trade + owner `set_autonomous_trading(true)` + `GATE_K_AUTONOMOUS_LOOP=1` + authenticated `POST /v1/gate-k/autonomous/start`. Never starts on deploy.

## Remaining blockers

1. Explicit operator approval for first broadcast
2. Policy WASM upgrade deployed on `i-a-a4e7` policy (autonomous field + mandate view)
3. Qualifying economically viable AI opportunity (thin edge correctly rejects)
4. Reconciler running at sign time
5. Gate K PASS only after independent reconcile of one AI-directed testnet tx
