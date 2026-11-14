# Mainnet Autonomy Activation Plan (J12)

**Status:** SHIP IN PROGRESS (2026-11-14). Plan READY; DeployContract blocked on Ledger USB (`DeviceNotFound`). Local WASM SHA matches J14 `8BF2AEAF…`. LIVE_LLM keeper cycle evidence recorded (`NO_TRADE`). Resume: `scripts/mainnet/ship-autonomy-today.ps1` with Ledger unlocked.

## Goal

Owner signs **once** → bounded mandate active → agent executes policy-valid operations without per-trade owner approval → keeper reconciles independently → pause/revoke/expiry stop new authorizations.

## Proposed contract change (local / testnet first)

| Item | Value |
|------|--------|
| Method | `activate_autonomous_mandate(limits, policy_hash, strategy_hash, enforce_autonomous_on_agent, autonomous_trading, unpause_now)` |
| Authority | Owner only |
| Effect | Atomic PolicyLimits + epoch bump + enforce flag + autonomous flag + optional unpause |
| Mainnet bytecode | **NOT DEPLOYED** — local SHA256 after J14 build `8BF2AEAF72FDF7675630684209FD7EA8BEB9A61CE3021A3B4B795B6E39B12931` (`policy.wasm` with `activate_autonomous_mandate` + `migrate_state_v1_autonomy`). Deployed mainnet remains `52Midc…` / artifact `3BC7C112…`. Owner must re-hash at upgrade time. |
| Migration | Additive WASM upgrade rehearsed on testnet (`J14_BORSH_UPGRADE_REHEARSAL.json` PASS). Owner-only `migrate_state_v1_autonomy` stamps `nio:state_version=1` without Borsh financial rewrite. |
| J15–J18 execution | Real EIP-155 signed-raw pipeline + keeper→executor wiring. **J18:** journal + trusted signer + **J18_TESTNET_PRE_SIGN_GO=GO**. Owner-authorized MPC→Sepolia ERC-20: op `j17-exec-77cc69`, Sepolia tx [`0xc9826ca6…`](https://sepolia.etherscan.io/tx/0xc9826ca6b7dc80f308fad18ff9ee136b9836907eb7df0ccdeb0f1ddf780c8b53) (1.0 Tidepool USDC to allowlisted recipient), independent Transfer-log + balance verify PASS, `reconcile_pending(Success)`. **J18_SEPOLIA_SETTLEMENT_GO=GO**. Not Intents settlement. `INTENTS_TESTNET=NOT_AVAILABLE`. **MAINNET_READY still NO-GO.** |

### Activation args preview (micro-mandate)

- `max_trade_value`: ≤ $5 USDC raw (6 decimals) for first micro-trade
- `daily_turnover_limit`: ≤ $20
- `max_pending_exposure`: ≤ $10
- `valid_until`: explicit ns expiry (≤ 7 days recommended for first enable)
- `token_scope`: `allowlist`
- `allowed_chains` / `allowed_assets` / `allowed_venues` / `allowed_destinations`: Mission 1/2 allowlists only
- `enforce_autonomous_on_agent`: `true`
- `autonomous_trading`: `true`
- `unpause_now`: **false** in preview; separate explicit unpause after dry observation

## Keeper → Mission 1/2 execution path

| Step | Autonomous keeper | Current supervised operator dependency |
|------|-------------------|----------------------------------------|
| Fresh quotes | Gate J / Intents 1Click quote path | Operator scripts may re-quote interactively |
| Signed quote attestation | Trusted quote signer (owner-configured) | Same — already on-chain |
| Propose bounded op | Agent `propose_*` under active mandate | **OK unattended** if unpaused + autonomous enforced |
| MPC `request_signature` | Policy contract path | **BLOCKER:** many ops paths still assume operator/Ledger confirmation UX |
| Persist signed raw tx | Durable tx journal (`packages/execution`) | Reusable if keeper owns journal lock |
| Broadcast exactly once | `durableBroadcast` | Reusable; **must not** retry on transport-only errors without receipt check |
| Cross-chain settle verify | Gate K settle + independent evidence | Partially automated; UNKNOWN must quarantine |
| Reconcile | Restricted reconciler, independently verified | Operator `ledgerReconcileDone` style flags must not alone clear UNKNOWN |
| Stop conditions | pause / revoke / expiry / UNKNOWN / budget | **OK** if keeper polls on-chain state each wake |

### Owner-approval dependencies that block true unattended mainnet

1. **WASM upgrade** of `policy.nishanthb.near` to include `activate_autonomous_mandate` (if deploying new method).
2. **Owner Ledger** call to `activate_autonomous_mandate` / `set_policy` + autonomy flags.
3. **Explicit unpause** (recommend separate from activate for first mainnet).
4. Any remaining **operator CLI confirmation** wrappers around MPC / broadcast in Mission scripts — keeper must call library primitives, not interactive scripts.
5. **Funding** of agent gas + EVM inventory under separate approval.
6. **Trusted quote signer** already set — verify read-only before enable.

## Rollback / emergency

1. Owner `pause` — blocks new agent proposes / signatures.
2. Owner `revoke` — increments epoch, pauses, blocks new authorizations; pending signed ops remain until settle/expiry.
3. Set `autonomous_trading=false` while `enforce_autonomous_on_agent=true` — blocks agent under enforce mode.
4. Do **not** share FullAccess keys between owner and agent (see J12 key audit).

## First micro-trade preview (not executed)

- Route: Mission-hardened path only (e.g. small USDC→NEAR or Base→NEAR per existing canary profiles).
- Size: min(mandate.max_trade, $1–$5).
- Mode: keeper LIVE_LLM decision must independently choose TRADE; **no forced trade**.
- Evidence: decision_hash + quote attestation + propose receipt + MPC digest bind + broadcast tx hash + settle proof + reconcile.

## HARD STOP acknowledgment

This document does not authorize mainnet mutation. Separate explicit owner approvals required for governance and funding.
