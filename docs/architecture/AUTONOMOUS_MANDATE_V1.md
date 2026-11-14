# Autonomous Mandate V1 — Architecture Decision Record

**Status:** Implemented (engineering foundation) — **NOT** mainnet-activated  
**Baseline HEAD at start:** `e048413d26d5ac93f6e3feded623a1ad4a0ef8ed`  
**Live read (2026-11-14):** `paused=true`, `mandate_epoch=2`, `get_autonomous_trading=false`, unresolved_pending=0

## Context

NIO’s owner signs a bounded mandate once (Ledger NEAR or Meteor). After activation, an isolated agent may execute **only** permitted operations without another owner signature per action. Owner retains exclusive authority to change policy, pause, revoke, withdraw, or raise budgets.

Historic financial ops (J8B, J9 M1, J9 M2) are immutable and out of scope.

## Security gap (Phase 1 audit)

| Control | On-chain today? | Notes |
|---------|-----------------|-------|
| pause / revoke / valid_until | **Yes** | `assert_active_mandate` |
| trade / daily / pending / asset / dest / gas | **Yes** | propose paths |
| digest binding + MPC path | **Yes** | contract-owned derivation |
| `autonomous_trading` | **Storage + view only** | Gate K checks off-chain; agent could propose/sign when unpaused even if flag=false |
| Env `GATE_K_*` | Off-chain | Bypassable by direct contract call |

**Gap:** Turning on product “autonomous mode” via Gate K alone is insufficient. A hot agent FullAccess key on `agent.nishanthb.near` can call propose/sign whenever the mandate is unpaused.

## Decision

1. **Canonical Mandate V1** off-chain schema/compiler (`packages/mandate/v1`) with honest enforcement labels.
2. **Contract hard gate (optional, default OFF):** `set_enforce_autonomous_on_agent(true)` makes `assert_active_mandate` also require `autonomous_trading==true`. Preserves existing canary unpause windows.
3. **Activation (future owner approval):** `set_policy` (limits) → `set_autonomous_trading(true)` → `set_enforce_autonomous_on_agent(true)` → `unpause` — each owner-signed; never auto.
4. **Agent must never** call set_policy, pause/unpause, revoke/unrevoke, set_autonomous_*, set_reconciler, withdraw, or change budgets.
5. **MPC deposit:** `request_signature` needs ≥1 yocto → FunctionCall-limited keys cannot complete MPC. Documented trade-off: tightly funded agent FullAccess for specific methods only — never owner/policy FullAccess.
6. **Shadow runtime only** until separate financial/governance approval: OpenRouter brain, mocked Agent Market, durable journal worker, mainnet UI **review-only**.

## What is ON-CHAIN_ENFORCED vs PLANNED / OFF_CHAIN_ONLY

| Constraint | Classification |
|------------|----------------|
| max_trade, daily_turnover, max_pending_exposure, slippage floor, gas budget, allowlists | **ON_CHAIN_ENFORCED** (existing PolicyLimits) |
| autonomous_trading when enforce_autonomous_on_agent=true | **ON_CHAIN_ENFORCED** (new, after WASM upgrade + owner toggle) |
| min_trade_interval, max_trades_per_period | **PLANNED** |
| commerce / marketplace purchase caps | **OFF_CHAIN_ONLY** (mocked; no on-chain commerce ledger yet) |
| OpenRouter spend / request caps | **OFF_CHAIN_ONLY** |
| LLM Critic / Fitter / Strategist | **OFF_CHAIN_ONLY** (defense in depth) |

Funded production activation is **blocked** until PLANNED on-chain guarantees required by the product claim exist, or the claim is narrowed.

## Contract migration / rollback

- **Change:** raw storage key `gate_k:enforce_autonomous_on_agent` + logic in `assert_active_mandate`. No Borsh layout bump.
- **Deploy:** owner FullAccess `DeployContract` only after separate approval. **Not done in this milestone.**
- **Rollback:** redeploy prior WASM; or owner sets `set_enforce_autonomous_on_agent(false)` and `pause`.
- **Mainnet:** keep paused; do not call set_autonomous_trading / set_enforce / unpause here.

## Agent / marketplace NEVER privileges

set_policy, pause/unpause, revoke/unrevoke, set_autonomous_trading, set_enforce_autonomous_on_agent, set_intents_signer_id, set_trusted_quote_signer, set_reconciler, owner withdraw/cancel, DeployContract, owner FullAccess, fabricating reconcile Success without verified evidence.

## Modules

| Area | Path |
|------|------|
| Schema / compiler / wallet preview | `packages/mandate/v1/` |
| Shadow agent / market mock / worker | `packages/autonomous/` |
| Policy gate | `contracts/policy/src/lib.rs` |
| Threat model | `docs/architecture/AUTONOMOUS_MANDATE_THREAT_MODEL.md` |
| Judge runbook | `docs/runbooks/JUDGE_AUTONOMOUS_PREVIEW.md` |

## Later live activation (owner + financial approval required)

1. Review Mandate V1 hash and enforcement map  
2. Testnet/sandbox WASM upgrade + activation dry-run  
3. Mainnet WASM upgrade (Ledger)  
4. Owner `set_policy` / autonomous / enforce / unpause ceremony  
5. Funded OpenRouter + marketplace balances (separate budgets)  
6. Enable hosted worker with credentials under OCI  
7. Explicit approval for first autonomous TRADE / real BUY_DATA  

**This document is engineering authorization only — not mainnet financial or governance approval.**
