# GATE H — Hardware Authority + Final Agent Backend

Date: 2026-11-09  
Network: NEAR **testnet** / Sepolia only (no mainnet)  
Artifacts: `evidence/live/gate-h-evidence.json`, `gate-h-decision.json`, `gate-h1-ledger-export.json`  
Script: `scripts/gate-h.mjs` · Wizard: `apps/web` → `/setup/ledger`  
Preserved: Gate G accounting PASS; F1 attestor trust; E3 post-revoke EVM execution

## Verdicts

| Check | Status |
|-------|--------|
| H1 Ledger physical ownership | **PASS** |
| H1 Contract upgrade authority | **PASS** (Ledger-only FullAccess on policy) |
| H2 Separate reconciler + off-chain verify | **PASS** |
| H3 Genuine decision loop | **PASS** |
| H4 Repo + integration contract | **PASS** |
| **Gate H overall** | **PASS** |

---

## H1 — Hardware + upgrade authority

### Ledger — PASS (hardware-only ownership verified)

Wizard: [http://127.0.0.1:5173/setup/ledger](http://127.0.0.1:5173/setup/ledger)  
Device: NEAR app **2.6.1** · path `44'/397'/0'/0'/3'`  
Ledger pubkey: `ed25519:9omQYtUWotq8AbBhYbfbG7BUbDPjpKRCgeyLQAW48Xjh`  
Seed phrases: never requested

| Step | Result | Tx |
|------|--------|-----|
| ADD_KEY owner (software migrate) | ok | `4pgYEJwXLfZXPTP9RzXGQrp2A9vLhfzujGBriwEctdL9` |
| ADD_KEY policy (software migrate) | ok | `31uwXK2fFbhu9PMLFTBfuRTAHSKWh3FfiaSyGQXEKSvG` |
| Hardware `set_policy` | **SUCCESS** | [`7SrK8M8eTFBGT6k6VxvaQBTwyMxa5TsdjXUiZkmMX2mb`](https://testnet.nearblocks.io/txns/7SrK8M8eTFBGT6k6VxvaQBTwyMxa5TsdjXUiZkmMX2mb) |
| Hardware `revoke` | **VERIFIED** `revoked=true` epoch **19** | [`EndhGnPpena59sKXkxEoQqAELmT3mjUfHr9DZpSHqRq9`](https://testnet.nearblocks.io/txns/EndhGnPpena59sKXkxEoQqAELmT3mjUfHr9DZpSHqRq9) |
| DELETE_KEY owner software | Ledger-signed | [`cC32MZm8DUizXndrR7gfWoCRowDcTRwPCZ4UcPM3fi7`](https://testnet.nearblocks.io/txns/cC32MZm8DUizXndrR7gfWoCRowDcTRwPCZ4UcPM3fi7) |
| DELETE_KEY policy software | Ledger-signed | [`EQZX8PBqJpwhVN3BA39CdkN6X3DqwDNADsZjdp1Xo3ok`](https://testnet.nearblocks.io/txns/EQZX8PBqJpwhVN3BA39CdkN6X3DqwDNADsZjdp1Xo3ok) |
| Unrevoke | optional / not required for PASS | `null` |

**Phase:** Hardware-only ownership verified · `hardware_ownership_pass: true`

### Access-key audit (final)

| Account | FullAccess keys |
|---------|-----------------|
| `nio-c-owner-857107.testnet` | **Ledger only** `ed25519:9omQYtUWotq8AbBhYbfbG7BUbDPjpKRCgeyLQAW48Xjh` |
| `nio-c-policy-857107.testnet` | **Ledger only** `ed25519:9omQYtUWotq8AbBhYbfbG7BUbDPjpKRCgeyLQAW48Xjh` |
| `nio-c-agent-857107.testnet` | `ed25519:7uNfAuj8jHDJawVppU8sVgxufDyFySZmcqMGtBMeHUXY` (agent; unchanged) |
| `nio-c-recon-857107.testnet` | dedicated reconciler software key (unchanged) |

Software FullAccess `ed25519:9itHoXewdGq3fK8DYmHwoo32MdP3QdjJpgPPamxTNvvt` **removed** from owner and policy.

### Upgrade authority

**Risk (still true in principle):** FullAccess on the policy contract can `DeployContract` and bypass policy.  
**Mitigation now:** that FullAccess is the **Ledger** key only — upgrades require physical device confirmation. Former dedicated contract software key and owner software key are gone.

**Note:** Mandate is currently **revoked** (`epoch=19`) from the hardware revoke proof. Use wizard **Unrevoke with Ledger** before further agent/MPC demos.

---

## H2 — Reconciliation trust

| Item | Evidence |
|------|----------|
| Prior risk | Agent == reconciler → compromised trader could assert false Success |
| New reconciler | `nio-c-recon-857107.testnet` |
| `set_reconciler` tx | `9J7ys87unn1ETpHD73bS7RXFrC1sExSi1XvqQkCAZPwY` |
| Colocated with agent? | **No** |
| Module | `packages/reconcile/verify-settlement.mjs` |

### Off-chain checks (trusted watchdog, not on-chain crypto)

1. Origin tx receipt + confirmations  
2. Sender, recipient, token, amount, chain expectations  
3. Tidepool terminal status + `nearTxHashes`  
4. Duplicate settlement blocked if already terminal  
5. **Never** Expire an already-**Signed** EVM op solely because quote deadline passed  

Contract still stores `evidence_hash` with `verified_onchain:false`.

---

## H3 — Autonomous strategy

Deterministic engine: `packages/strategy/decide.mjs`  
Decision artifact: `evidence/live/gate-h-decision.json`

| Field | Value |
|-------|-------|
| Choice | **TRADE** |
| Strategy | `origin-usdc-to-wnear-v1` |
| Amount | `1000000` (1 USDC) |
| Rationale | Quote viable; capacity ok; mandate active |
| minAmountOut observed | `279036267004249282582560` |
| AI used as enforcement | **No** |

### Execution trace (F4 path reuse)

| Step | Hash / id |
|------|-----------|
| Operation | `h3-1794231966936` |
| Propose | `Ev1Uy7eQ4Zf8jG8WyC8cAKp9S3VhDiQrn94wngt9tkoD` |
| MPC sign | `CGbXc3cHHv1jWGeaK4Xj2mAqE29NQ2UhmrgaUr9udKPC` |
| Sepolia | [`0xba28b97b…`](https://sepolia.etherscan.io/tx/0xba28b97b8102dc160db6d89243c67e14538aef1cc0f415f7fbb2f9d903446d09) status `0x1` |
| Tidepool | **SUCCESS** |
| Reconcile (reconciler) | `CFj1Q12DVjEs6SCC2iATjju89hDK6Lzaz5TLBmauEeZ1` |

---

## H4 — Repository + integration

| Item | Result |
|------|--------|
| Root `.git` | Present |
| `.gitignore` | Credentials / `.env` / attestor seeds ignored |
| Public push | **Not performed** |
| Ledger wizard | `apps/web` `/setup/ledger` |
| Typed interfaces | `packages/agent-api/types.ts` |

---

## Remaining risks

1. **`evidence_hash` not on-chain verified** — reconciler/owner watchdog trust.  
2. **F1** — Tidepool maker signatures still not independently verified.  
3. **E3** — exported ECDSA survives NEAR revoke.  
4. **Single Ledger key** — loss of device/seed without backup = loss of owner/upgrade control (operational, not a gate FAIL).

## Reproduction

```powershell
cd E:\near-intent-one\apps\web
npm run dev
# http://127.0.0.1:5173/setup/ledger
```
