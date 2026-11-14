# J15 — Mainnet Activation Readiness Decision

**Baseline:** `6285ebe`  
**HARD STOP:** No mainnet WASM upgrade, activation, unpause, Ledger signing, new mainnet MPC, EVM broadcast, funding, or autonomous spending. Mainnet policy remains paused.

## Gate verdicts

| Gate | Verdict | Evidence |
|------|---------|----------|
| MPC_SIGNATURE_RECOVERY | **PASS** (local ECDSA + M1 readonly recover) | `J15_LOCAL_FORK_SETTLEMENT_PROOF.json`, `J15_M1_M2_READONLY_REPLAY.json` |
| REAL_SIGNED_EVM_TRANSACTION | **PASS** (EIP-155 raw assembled & policy-validated) | Local fork proof |
| REAL_TESTNET_OR_LOCAL_FORK_BROADCAST | **PASS_LOCAL_FORK** | Local JSON-RPC broadcast + replay reject |
| INDEPENDENT_SETTLEMENT_VERIFICATION | **PASS_LOCAL_FORK** | Receipt + ERC-20 Transfer log check |
| AUTONOMOUS_KEEPER_TO_EXECUTOR | **PASS** | `J15_KEEPER_TO_EXECUTOR.json` (LIVE_LLM NO_TRADE + FIXTURE trade path) |
| RECONCILIATION_PROOF | **PASS_LOCAL_FORK** | Independent evidence required before RECONCILED |
| MAINNET_READY_FOR_SEPARATE_OWNER_APPROVAL | **NO-GO** | See remaining blockers |

`PASS_LOCAL_FORK` is **not** a mainnet autonomous settlement claim.

## What J15 closed

1. Removed production reliance on `TESTNET_MPC_PENDING` / `SIMULATED_SIGNED_RAW` in financial modes (fail-closed).
2. Added `signedTxPipeline.mjs` reusing Gate-K + quote-auth: MPC extract → recover → EIP-155 serialize → validate → broadcast once → receipt settle.
3. LOCAL_FORK end-to-end: real ECDSA raw → journal → broadcast → settle → reconcile (replay rejected).
4. Keeper wired to `runAutonomousExecution` for LOCAL_FORK/TESTNET adapters; MAINNET refused; LIVE_LLM not forced to TRADE (observed `NO_TRADE` / `NO_OPPORTUNITY`).
5. M1 signed raw recovered readonly (`0xee82d6…`); M2 lifecycle RECONCILED evidence confirmed readonly.

## Still NO-GO for mainnet owner approval

1. Mainnet WASM still `52Midc…` — no `activate_autonomous_mandate` / migrate on-chain (J14 rehearsal only).
2. Policy paused; autonomy enforce method absent on deployed bytecode.
3. No **live testnet** Intents/EVM funded settlement through NEAR MPC→broadcast in J15 (LOCAL_FORK substituted, labeled).
4. Production `NIO_TX_JOURNAL_SECRET`, attestor, reconciler ops not production-certified here.
5. Owner has not approved upgrade / activate / unpause / funding.

## Proposed owner-governance sequence (preview only)

1. Re-hash local WASM (`8BF2AEAF…` from J14) at upgrade time.
2. Owner-controlled **DeployContract** on `policy.nishanthb.near`.
3. Owner `migrate_state_v1_autonomy` (idempotent stamp).
4. Owner `activate_autonomous_mandate` with `unpause_now: false` (micro-mandate limits).
5. Observation window; then **separate** owner `unpause`.
6. Fund gas + micro USDC under mandate; enable keeper with journal secret + reconciler.
7. First trade ≤ min(mandate, $1–$5) via Fitter-bound path only.

### First micro-mandate (preview)

- `max_trade_value`: `5000000` ($5)
- `daily_turnover_limit`: `20000000`
- `max_pending_exposure`: `10000000`
- `valid_until`: ≤ 7 days
- Mission 1/2 allowlists only
- `enforce_autonomous_on_agent`: true
- `autonomous_trading`: true
- `unpause_now`: **false**

## Emergency

Owner `pause` / `revoke`; UNKNOWN quarantine (no resign/blind rebroadcast); WASM rollback to `3BC7C112…` only if layout still compatible.

## Commands

```bash
npm run test:j15
npm run j15:local-fork
npm run j15:replay-readonly
npm run j15:keeper-executor
```
