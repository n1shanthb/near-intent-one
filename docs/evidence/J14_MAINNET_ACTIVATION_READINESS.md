# J14 — Mainnet Autonomy Activation Readiness

**Status:** Engineering package only. **HARD STOP** — no mainnet upgrade, key change, activation, unpause, MPC, broadcast, funding, or autonomous spending was performed in J14.

**Baseline:** `4e8ccc8`  
**Local new policy WASM SHA256:** `8BF2AEAF72FDF7675630684209FD7EA8BEB9A61CE3021A3B4B795B6E39B12931` (638108 bytes)  
**Evidence date:** 2026-11-14

---

## 1. Current deployed policy code hash and state version

| Item | Value |
|------|--------|
| Account | `policy.nishanthb.near` |
| On-chain `code_hash` | `52MidcEUUwVaiNcTtuQbKd1xwVQR8HGer4quihZj8FZZ` |
| Artifact SHA256 (matches deployed) | `3BC7C1120A1F593A4C96FF58171CE9521F780CEEC0427D97F90F0CAC9ECC4F90` (625701 B) |
| Owner | `nishanthb.near` |
| Agent | `agent.nishanthb.near` |
| Portfolio | `nio-mainnet-v1` |
| `get_paused` | `true` |
| `get_mandate_epoch` | `2` |
| `get_autonomous_trading` | `false` |
| `get_enforce_autonomous_on_agent` | **MethodNotFound** (not in deployed WASM) |
| `get_state_version` | **MethodNotFound** (not in deployed WASM) |
| Unresolved pending | `0` |

State version on mainnet today is **implicit / pre-v1** (no `nio:state_version` stamp until post-upgrade migrate).

---

## 2. Proven migration method and locally tested new WASM hash

**Model:** `ADDITIVE_WASM_UPGRADE_NO_BORSH_REWRITE`

1. Deploy exact mainnet artifact (`3BC7C112…`) to a fresh testnet account.
2. Init + populate nonempty state (limits, pending op, turnover, intents signer, policy hashes).
3. Upgrade in place to local WASM `8BF2AEAF…`.
4. Owner calls `migrate_state_v1_autonomy` (idempotent raw-storage stamp only — **no** Borsh financial rewrite, **no** `unwrap_or_default` reset).
5. Verify owner/agent/MPC path/portfolio/limits/epoch/pending/turnover preserved.
6. Owner may then call `activate_autonomous_mandate` (separate from migrate).

**Rehearsal:** `docs/evidence/J14_BORSH_UPGRADE_REHEARSAL.json` — **verdict PASS**  
Policy: `j14u95c4.nio-j13-998a-owner.testnet`  
Upgrade tx: `65oA6KUND1dGyBZoUU929bxtBwVsdwVjjpLJBjVUeFk`  
Migrate tx: `3vtHARWjAWMud28PemygaMdzmF5LRzz2X2HH8qq1Cvpj`  
`state_version_after_migrate`: `1`

**Rollback:** Redeploy previous WASM bytes (`3BC7C112…`). Safe only while Borsh layout remains compatible (verified in rehearsal). If layout ever diverges, **do not** upgrade without an explicit Borsh migrate module — verdict becomes NO-GO.

**Deploy preview (mainnet — NOT executed):**
- Signer: policy FullAccess deploy key or owner-controlled upgrade path used historically for `policy.nishanthb.near`
- Action: `DeployContract` with bytes SHA256 `8BF2AEAF…`
- Then owner: `migrate_state_v1_autonomy` `{}`
- Then (separate approval): `activate_autonomous_mandate` / optional separate `unpause`

---

## 3. Exact owner Ledger activation arguments

Recommend **two** owner signatures (not one total):

**A. `activate_autonomous_mandate`** with `unpause_now: false`:

```json
{
  "limits": {
    "max_trade_value": "5000000",
    "daily_turnover_limit": "20000000",
    "max_pending_exposure": "10000000",
    "max_slippage_bps": 100,
    "allowed_assets": ["<Mission1/2 canonical allowlist only>"],
    "allowed_destinations": ["<Mission1/2 allowlist only>"],
    "valid_until": "<ns expiry ≤ 7 days>",
    "token_scope": "allowlist",
    "allowed_chains": ["near", "eip155:1", "eip155:42161", "eip155:8453"],
    "allowed_venues": ["near_intents_1click"],
    "max_gas_budget": "2500000000000000"
  },
  "policy_hash": "<owner-chosen hash>",
  "strategy_hash": "<owner-chosen hash>",
  "enforce_autonomous_on_agent": true,
  "autonomous_trading": true,
  "unpause_now": false
}
```

**B. Separate explicit `unpause`** after dry observation.

`unpause_now=false` means activation is **not** a single wallet signature total.

---

## 4. Agent software-key isolation

J13 audit (baseline `4e8ccc8`): agent ops key isolated; owner Ledger path for recovery — **PASS** on testnet.  
Mainnet: agent `agent.nishanthb.near` must retain **no** owner FullAccess; upgrade/activation remain owner Ledger. Re-verify keys immediately before any mainnet upgrade.

---

## 5. Autonomous executor coverage and untested boundaries

| Covered | Untested / partial |
|---------|-------------------|
| Fitter-only executable amount (`fitted_size_raw`) | Live LIVE_LLM → TRADE → full settle on mainnet routes |
| Chain revalidation (pause/revoke/epoch/quote bind) | Genuine EVM broadcast + settlement on all Mission routes |
| Journal secret fail-closed for TESTNET/MAINNET | Production journal secret provisioning |
| Ambiguous RPC → UNKNOWN, no resign | Long-running keeper crash mid-flight on mainnet RPC |
| Competing worker lock | Multi-region keeper failover |
| Testnet propose + MPC `signed` event via execution service | Cross-chain settle + independent reconcile E2E |
| Borsh additive upgrade rehearsal with pending state | Mainnet upgrade itself (HARD STOP) |

---

## 6. Prerequisites (gas, USDC, signing, quote attestor, reconciler)

- Agent gas (NEAR) for propose + `request_signature` (1 yocto)
- Policy storage/gas for upgrade
- USDC inventory under mandate allowlist (micro size)
- MPC signer + derivation path unchanged (`trading/v1/portfolio/<portfolio_id>`)
- Trusted quote attestor keys already configured — re-verify read-only
- Independent reconciler credentials; reconciler must **not** invent Success
- `NIO_TX_JOURNAL_SECRET` (≥32 chars) required for financial persistence

---

## 7. Minimal first micro-mandate and max combined exposure

| Knob | First micro recommendation |
|------|----------------------------|
| `max_trade_value` | ≤ `$5` USDC raw (`5000000`) |
| `daily_turnover_limit` | ≤ `$20` |
| `max_pending_exposure` | ≤ `$10` |
| `valid_until` | ≤ 7 days |
| First trade size | min(mandate, `$1`–`$5`) via **Fitter** only |

---

## 8. Emergency pause / revoke / recovery

1. Owner `pause` — blocks new proposes/signatures.
2. Owner `revoke` — epoch bump, pause, blocks new authorizations; pending signed ops remain until settle/expiry.
3. `autonomous_trading=false` while `enforce_autonomous_on_agent=true` — blocks agent under enforce mode.
4. UNKNOWN quarantine — no resign, no blind rebroadcast; clear only with independent verified evidence.
5. WASM rollback — redeploy `3BC7C112…` only if layout still compatible.

---

## 9. Independent reproducible test evidence

| Artifact | Result |
|----------|--------|
| `docs/evidence/J14_BORSH_UPGRADE_REHEARSAL.json` | PASS |
| `docs/evidence/J14_E2E_EXECUTION_SERVICE.json` | PARTIAL (propose+MPC; settle unsupported) |
| `npm run test:j14` | 17 refusal/binding tests PASS |
| J13 mandate/MPC/key isolation | Prior PASS (not re-done) |

Commands:

```bash
npm run j14:upgrade-rehearse
npm run j14:e2e
npm run test:j14
```

---

## 10. Remaining reasons for NO-GO

1. Mainnet WASM not upgraded; `activate_autonomous_mandate` / `migrate_state_v1_autonomy` absent on-chain.
2. Policy remains **paused**; autonomy flags off / enforce method missing.
3. No genuine end-to-end **settlement** proof (MPC `signed` ≠ settled).
4. EVM route broadcast/settle still labeled LOCAL_FORK_OR_UNSUPPORTED in J14 harness.
5. Owner has not separately approved upgrade, activation, unpause, or funding.
6. Production journal secret + reconciler ops not production-certified in this milestone.

---

## Gate verdicts (J14)

| Gate | Verdict |
|------|---------|
| MIGRATION_SAFE | **PASS** (additive upgrade rehearsed; migrate is stamp-only; rollback documented) |
| FITTER_EXECUTION_BINDING | **PASS** |
| END_TO_END_TESTNET_SETTLEMENT | **NO-GO** (propose+MPC yes; settle/reconcile not claimed) |
| AUTONOMOUS_KEEPER_EXECUTION | **PARTIAL** (non-interactive service through MPC; not full settle) |
| UNKNOWN_RECOVERY | **PASS** (unit/refusal proofs) |
| MAINNET_READY_FOR_SEPARATE_OWNER_APPROVAL | **NO-GO** |

---

## HARD STOP acknowledgment

J14 did not mutate mainnet. Separate explicit owner approvals are required for any upgrade, activation, unpause, funding, or autonomous spending.
