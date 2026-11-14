# NIO J13 — Secure Autonomous Execution Integration

**Baseline:** `e3b600c8b85de54cf0eb7a10e4651d8d7698ee19`  
**Hard stop honored.**

## Verdicts

| Gate | Verdict | Evidence |
|------|---------|----------|
| KEY_ISOLATION_TESTNET | **PASS** | Software ops only on agent; Ledger FA shared=recovery-by-design. `J13_KEY_ISOLATION_AUDIT.json` |
| DEPLOYED_MANDATE_TESTNET | **PASS** | Fresh `j13pol.nio-agent-02b7cf.testnet`; owner activate once; agent 2× propose; over-limit reject; revoke blocks |
| MPC_END_TO_END_TESTNET | **PASS_TX_SUBMITTED** | Tx `5xEH5uD7BgV1jdq7wMmQwjYBhhnAC6DLixtWkeR1S6FQ` — 1 yocto + MPC `signed` event |
| AUTONOMOUS_EXECUTOR | **PASS_ADAPTER** | `executorAdapter.mjs` plans M1/M2 path; per-trade Ledger not required inside mandate; reconcile never bypassed; MAINNET mode hard-stopped |
| RESTART_RECOVERY | **PASS** | 13/13 failure tests (lock, corruption, UNKNOWN, ambiguous broadcast, pause/revoke blockers) |
| MAINNET_ACTIVATION_READINESS | **NOT READY** | Preview only — see `J13_MAINNET_ACTIVATION_PREVIEW.md` |

## Testnet proof anchors

- Policy: `j13pol.nio-agent-02b7cf.testnet`
- Owner: `nio-owner-02b7cf.testnet` (pk `ed25519:BNfx…`)
- Agent: `nio-agent-02b7cf.testnet` (pk `ed25519:5MeC…`)
- Propose txs: `FCibeA7b…`, `8pQJhcHU…`
- Revoke tx: `BDtD98jd…`
- MPC: deposit=1 yocto; log `EVENT_JSON:{"event":"signed",...}`

## Unavailable / honest limits

- Testnet faucet partially rate-limited for new top-level accounts; used funded 02b7cf trio + fresh subaccount.
- Blind WASM upgrade of older Gate I policy state traps (`unreachable`) — mainnet upgrade needs migration plan.
- Full funded EVM broadcast / settlement not exercised (hard stop + not required for mandate/MPC deposit proof).

## Files

- `docs/architecture/J13_KEY_ISOLATION_DESIGN.md`
- `packages/autonomous/executorAdapter.mjs`, `j13.failure.test.mjs`
- `scripts/j13/key-isolation-audit.mjs`, `deploy-mandate-testnet.mjs`, `complete-mandate-proof.mjs`
- Evidence under `docs/evidence/J13_*`
