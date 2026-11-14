# J13 — Mainnet Activation Preview (OWNER APPROVAL BOUNDARY)

**HARD STOP:** No mainnet key changes, WASM upgrade, policy mutation, unpause, mandate activation, MPC, broadcast, or funded spend in this milestone.

## Verdict summary

| Gate | Verdict |
|------|---------|
| KEY_ISOLATION_TESTNET | **PASS** (software ops isolated; Ledger FA shared by design) |
| DEPLOYED_MANDATE_TESTNET | **PASS** (`j13pol.nio-agent-02b7cf.testnet`) |
| MPC_END_TO_END_TESTNET | **PASS_TX_SUBMITTED** (1 yocto + MPC sign receipt) |
| AUTONOMOUS_EXECUTOR | **PASS_ADAPTER** (plan/broadcast/reconcile gates; mainnet hard-stopped) |
| RESTART_RECOVERY | **PASS** (failure suite: lock, integrity, UNKNOWN, no resign) |
| MAINNET_ACTIVATION_READINESS | **NOT READY** — blocked until owner executes key-isolation ceremony confirmation + WASM upgrade approval |

## Key-isolation migration (mainnet — plan only)

1. Confirm ops FA `ed25519:DZUE…` only on `agent.nishanthb.near` (already true).
2. Keep Ledger FA `ed25519:7AMs…` on owner + policy; agent Ledger FA optional for recovery.
3. **Never** AddKey ops software to owner/policy.
4. **Never** DeleteKey last FA on any account.
5. Rollback: re-AddKey Ledger FA if ever removed from agent after dual-recovery proven.

## Policy WASM

| Item | Value |
|------|--------|
| Local SHA256 | `E433C6CFB8F61E0E2E873814D21659B379EDE19D97149026702C916773BE2BB2` |
| Method | `activate_autonomous_mandate` |
| State migration | **Fresh deploy or audited migration required** — raw upgrade of older Borsh state caused `unreachable` on Gate I policy; do not blind-upgrade mainnet |

## One-time Ledger activation args (preview)

- `enforce_autonomous_on_agent: true`
- `autonomous_trading: true`
- `unpause_now: false` (separate step)
- Micro limits: max_trade ≤ $5 USDC raw; daily ≤ $20; pending ≤ $10; `valid_until` ≤ 7d; allowlist Mission 1/2 assets

## Executor permissions / gas

- Agent software FA must attach 1 yocto for `request_signature`
- Funded gas on agent: ≥ 0.5 NEAR recommended after activation
- Attestor: trusted quote signer (already mainnet-configured path)
- Reconciler: **never** bypassed by autonomous keeper

## First autonomous micro-trade

- Only if LIVE_LLM independently selects TRADE
- Budget: min(mandate.max_trade, $1–$5)
- Path: keeper → executorAdapter → M1/M2 library primitives (not interactive CLIs)

## Emergency

1. Owner Ledger `pause`
2. Owner Ledger `revoke`
3. `autonomous_trading=false` under enforce mode
4. Settlement recovery via independent evidence only

## Owner approval boundary

Separate explicit approvals required for: (1) key ceremony acknowledgment, (2) WASM upgrade, (3) activate, (4) unpause, (5) first funded micro-trade.
