# GATE I — Real Usable Testnet Product

Date: 2026-11-10 (closure PASS)  
Network: NEAR **testnet** / Sepolia only (no mainnet)  
Architecture: [docs/CUSTODY_ISOLATION.md](docs/CUSTODY_ISOLATION.md)  
Funding plan: [docs/GATE_I_FUNDING_PLAN.md](docs/GATE_I_FUNDING_PLAN.md)  
Deploy: [docs/GATE_I_DEPLOY.md](docs/GATE_I_DEPLOY.md) · OCI: [docs/GATE_I_OCI.md](docs/GATE_I_OCI.md) · Chat 2: [docs/GATE_I_INTEGRATION.md](docs/GATE_I_INTEGRATION.md)  
Artifacts: `evidence/live/gate-i-*.json` (closure: `gate-i-closure.json`)  
**Demo Ledger accounts (`nio-c-*`) were not modified** (Ledger-only FullAccess `ed25519:9omQYt…` verified).

## Overall: **PASS**

| Metric | Count |
|--------|------:|
| PASS | 15 |
| FAIL | 0 |
| BLOCKED | 0 (former B1–B3 closed) |

---

## Pre-flight (2026-11-10 faucet)

| Check | Result |
|-------|--------|
| Faucet tx | `0xe1790149aff92e30a3a55c4464720f45452c5e5a7cc8119da7729b7162c69a02` |
| Status | **0x1** (block 12103022) |
| To | Portfolio A `0x30af279bedef3bb82c7f47bb9f6a514f6264e752` |
| Value | **0.05 ETH** (not assumed 0.02 — verified on-chain) |
| A after | **0.05 ETH**, **50 USDC** (before closure spend) |

### Closure plan audit (before run)

| Item | Value | Safe? |
|------|-------|-------|
| Withdraw destination | `0x9950ce47498ab3a83b278879aa9f0e477346ac39` | Yes — approved recipient key |
| Withdraw amount | **0.1 USDC** (`100000`) | Yes |
| Trade budget | **1 USDC** (`1000000`) | Yes — A had 50 USDC |
| Combined spend | 1.1 USDC + gas | Yes — ≪ 50 USDC / 0.05 ETH |
| Idempotency | `operation_id` = `i-wd-<Date.now()>` / `i-trade-<Date.now()>` | Yes — unique per run |
| Demo isolation | `assertNotDemo` + no `nio-c-*` in provision | Yes |

---

## Former blockers → PASS

### B1 — `I2.deposit_fund` → **PASS**

| | |
|--|--|
| ETH fund | `0xe1790149…c69a02` → A, **0.05 ETH**, status `0x1` |
| USDC fund | Prior funder→A 50 USDC (see funding plan); A held 50 USDC pre-closure |
| Acceptance | `a_eth > 0` and `a_usdc > 0` with hashes in `gate-i-closure.json` |

### B2 — `I2.withdraw_sepolia_receipt` → **PASS**

| | |
|--|--|
| NEAR auth (paused) | `GRosRgjDyBPoQtbiaH3Z6eyDwzCGqUprociztmadsLye` (`withdraw_signed`, op `i-wd-1794294110470`) |
| Sepolia broadcast | [`0x2d11b9a650b92f422c39edbe89002f4722598adf44367e0f6a79bcd89a33408d`](https://sepolia.etherscan.io/tx/0x2d11b9a650b92f422c39edbe89002f4722598adf44367e0f6a79bcd89a33408d) |
| Receipt | `status=0x1`, gasUsed `140830` |
| Transfer | A → `0x9950ce47…ac39`, **0.1 USDC** (ERC-20 `Transfer` log amount `100000`) |
| Live recipient bal | **0.1 USDC** |
| Unauthorized | owner_B + agent rejected (`I2_withdraw_authz_separation` **PASS**) |
| Note | Script first marked FAIL due to RPC-stale `after` balances; on-chain log + live balances prove delivery (corrected in evidence). |

### B3 — `I2.trade_unattended` → **PASS**

| | |
|--|--|
| Origin Sepolia | [`0x26b9c08a722004a1ef548bfe71cb8f4efd7af06df8de5a0e33705c744ae16e54`](https://sepolia.etherscan.io/tx/0x26b9c08a722004a1ef548bfe71cb8f4efd7af06df8de5a0e33705c744ae16e54) — 1 USDC → Tidepool deposit `0xa8f41fbd…3db8` |
| Tidepool | **SUCCESS** (NEAR swaps `34kdSBs9…`, `H9G4oifL…`, `DV5RGSt2…`) |
| Reconcile | `EKA95wowjKttggRsZhxJyUrbctmN22UkQQwwdfakTDsR` on `policy.nio-i-a4e7-a-owner.testnet` |
| B isolation | B cannot `pause` A (`I1_b_cannot_interfere` **PASS**) |

### Post-closure balances (live)

| Address | ETH | USDC |
|---------|-----|------|
| A `0x30af279b…e752` | ~0.04966 | **48.9** |
| Recipient `0x9950ce47…ac39` | — | **0.1** |

---

## Acceptance matrix (current)

| Check | Status | Evidence |
|-------|--------|----------|
| I1.new_wallet_onboarding | **PASS** | gate-i-provision.json |
| I1.distinct_identities | **PASS** | gate-i-isolation.json |
| I1.cross_user_reject | **PASS** | gate-i-isolation.json |
| I1.demo_untouched | **PASS** | Ledger keys unchanged on `nio-c-*` |
| I1.b_cannot_interfere | **PASS** | gate-i-closure.json |
| I2.view_deposit_identity | **PASS** | gate-i-lifecycle.json |
| I2.balances_read | **PASS** | gate-i-lifecycle.json |
| I2.deposit_fund | **PASS** | `0xe1790149…` + 50 USDC on A |
| I2.withdraw_authorization_paused | **PASS** | `GRosRgjD…` / prior `8mvQe6Sk…` |
| I2.withdraw_sepolia_receipt | **PASS** | `0x2d11b9a6…` + Transfer 0.1 USDC |
| I2.trade_unattended | **PASS** | `0x26b9c08a…` + Tidepool SUCCESS + reconcile |
| I4.valuation_fail_closed | **PASS** | packages/valuation |
| I3.hosted_health | **PASS** | local + OCI `/v1/health` |
| I3.service_restart_recovery | **PASS** | gate-i-service-boot.json |
| I3.deployable_api | **PASS** | Dockerfile + OCI `docs/GATE_I_OCI.md` |
| I5.ledger_onboarding_path | **PASS** | LedgerWizard preserved; demo not mutated |
| I5.revoke / pause owner-only | **PASS** | isolation |

---

## I1 — Multi-user governance

| User | Owner | Policy | Path | EVM |
|------|-------|--------|------|-----|
| A | `nio-i-a4e7-a-owner.testnet` | `policy.nio-i-a4e7-a-owner.testnet` | `trading/v1/portfolio/i-a-a4e7` | `0x30af279bedef3bb82c7f47bb9f6a514f6264e752` |
| B | `owner.nio-i-a4e7-agent.testnet` | `policy.owner.nio-i-a4e7-agent.testnet` | `trading/v1/portfolio/i-b-a4e7` | `0xe37d726f21386ff39ec4c04a6814259d85214f63` |

Agent `nio-i-a4e7-agent.testnet` · Reconciler `nio-i-a4e7-recon.testnet`  
Isolation **PASS**: B cannot `set_policy` / `revoke` / `owner_request_withdraw_signature` on A; agent cannot owner-withdraw.

---

## I2 — Withdrawal rules (strict)

A completed withdrawal requires **all** of:

1. Destination chain = **Sepolia** (`chain_id=11155111`)
2. Broadcast tx hash + receipt `status=0x1`
3. Recipient + asset (USDC) + before/after balances
4. Owner path while agent trading paused/revoked
5. Unauthorized user/agent rejected

NEAR `withdraw_signed` alone = authorization evidence only (**not** completion).  
**B2 now satisfies broadcast + receipt + Transfer log + live recipient balance.**

---

## I3 — Deployable API

| Item | Value |
|------|-------|
| Process | `node packages/services/api-server.mjs` |
| Health | `GET /v1/health` |
| OCI | `http://129.225.72.169:8787/v1` (`docs/GATE_I_OCI.md`) |
| Auth | `GATE_I_API_KEY` required for POST when set |
| Persistence | `GATE_I_DATA_DIR` volume |
| Container | `packages/services/Dockerfile` |

---

## I4 — Valuation

`packages/valuation/units.mjs` — USDC≠wNEAR; fail closed without pricing.

---

## I5 — Chat 2 frontend contract

See `docs/GATE_I_INTEGRATION.md`.

**Chat 2 notify:** `VITE_GATE_I_WITHDRAW_PROVEN=true` is now authorized (Sepolia withdraw receipt PASS).

---

## Security boundaries (unchanged)

1. Per-user policy + `trading/v1/portfolio/<id>`  
2. Owner-only withdraw/policy; agent-only trade  
3. No shared upgrade master key  
4. Demo Ledger portfolio isolated — no unrevoke / no key migrate  
5. Fail-closed valuation  
6. Testnet only  

## Remaining (non-blocker)

1. **Public DNS / TLS** in front of OCI IP (optional hardening).  
2. **Self-serve HTTP portfolio factory** for arbitrary wallets — still guided-blocked (provisioner script works).  
3. Closure script: poll ERC-20 balances after receipt until Transfer reflected (avoid stale FAIL).
