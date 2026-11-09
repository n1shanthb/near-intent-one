# GATE H — Hardware Authority + Final Agent Backend

Date: 2026-11-09  
Network: NEAR **testnet** / Sepolia only (no mainnet)  
Artifacts: `evidence/live/gate-h-evidence.json`, `gate-h-decision.json`  
Script: `scripts/gate-h.mjs`  
Preserved: Gate G accounting PASS; F1 attestor trust; E3 post-revoke EVM execution

## Verdicts

| Check | Status |
|-------|--------|
| H1 Ledger physical ownership | **BLOCKED** |
| H1 Contract upgrade authority | **PASS** (software owner still upgrade-capable until Ledger) |
| H2 Separate reconciler + off-chain verify | **PASS** |
| H3 Genuine decision loop | **PASS** |
| H4 Repo + integration contract | **PASS** |
| **Gate H overall** | **BLOCKED** (Ledger incomplete) |

---

## H1 — Hardware + upgrade authority

### Ledger — BLOCKED

| Item | Result |
|------|--------|
| Physical device session | **Not available** |
| Hardware `set_policy` tx | `null` |
| Hardware `revoke` tx | `null` |
| Owner software FullAccess remaining | **1** (`ed25519:9itHoXewdGq3fK8DYmHwoo32MdP3QdjJpgPPamxTNvvt`) |
| Seed phrases | Never requested |
| Prepared flow | `scripts/ledger/01`–`05` |

### Access-key audit (after H1 mitigation)

| Account | FullAccess keys |
|---------|-----------------|
| `nio-c-owner-857107.testnet` | `ed25519:9itHoXewdGq3fK8DYmHwoo32MdP3QdjJpgPPamxTNvvt` (software) |
| `nio-c-policy-857107.testnet` | **same owner key only** |
| `nio-c-agent-857107.testnet` | `ed25519:7uNfAuj8jHDJawVppU8sVgxufDyFySZmcqMGtBMeHUXY` |
| `nio-c-recon-857107.testnet` | dedicated reconciler software key |

### Upgrade authority (critical)

**Risk:** Whoever holds **FullAccess on the policy contract account** can `DeployContract` (replace WASM), bypass policy checks, and still drive the contract-controlled MPC signer path.

**Before Gate H:** contract had dedicated FullAccess `ed25519:G1cuNDdAcrYsJtt3jPdcVc9aQQ3jpCmdU7RXvyCG4VMS` (software in `.near-credentials`).

**Mitigation applied:** dedicated contract FullAccess removed; upgrade authority consolidated onto the **owner** FullAccess key. Confirmed live: contract keys = owner pk only.

**Remaining risk (disclosed):** until Ledger owns the owner account, a compromised **owner software key** can still upgrade the contract. Ledger completion (`scripts/ledger/05-contract-upgrade-authority.INSTRUCTIONS.md`) is required to close this.

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

Rule demos in evidence: signed-without-receipt → refuse; Reserved/None → may Expire; already Success → duplicate blocked.

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
| AI used as enforcement | **No** (optional only; unused) |

### Execution trace (F4 path reuse)

| Step | Hash / id |
|------|-----------|
| Operation | `h3-1794231966936` |
| Propose | `Ev1Uy7eQ4Zf8jG8WyC8cAKp9S3VhDiQrn94wngt9tkoD` |
| MPC sign | `CGbXc3cHHv1jWGeaK4Xj2mAqE29NQ2UhmrgaUr9udKPC` |
| Sepolia | [`0xba28b97b8102dc160db6d89243c67e14538aef1cc0f415f7fbb2f9d903446d09`](https://sepolia.etherscan.io/tx/0xba28b97b8102dc160db6d89243c67e14538aef1cc0f415f7fbb2f9d903446d09) status `0x1` |
| Tidepool | **SUCCESS** |
| Off-chain verify | origin ok + tidepool ok → Success |
| Reconcile (reconciler actor) | `CFj1Q12DVjEs6SCC2iATjju89hDK6Lzaz5TLBmauEeZ1` |
| Evidence hash stored | `5mswTKnFdrsRwc5E372fuNrTeExxQ8gRfDPrE9CrmAgr` (`verified_onchain:false`) |

No fabricated P/L. Contract remained the enforcement boundary.

---

## H4 — Repository + integration

| Item | Result |
|------|--------|
| Root `.git` | Present (ours; nested clone git removed) |
| `.gitignore` | Covers `.near-credentials/`, `.env*`, `node_modules/`, `*.wasm`, attestor seeds, `evidence/live/*` |
| Public push | **Not performed** |
| `apps/web` edited | **No** |
| Typed interfaces | `packages/agent-api/types.ts` |
| API doc | `packages/agent-api/API.md` |

Surfaces documented: policy/epoch, exposure, decisions, quote auth, MPC signing, settlement, Ledger state, revocation/reconciler, upgrade authority.

---

## Remaining risks

1. **Ledger BLOCKED** — owner (and thus contract upgrade) still software FullAccess.  
2. **`evidence_hash` not on-chain verified** — reconciler/owner watchdog trust.  
3. **F1** — Tidepool maker signatures still not independently verified.  
4. **E3** — exported ECDSA survives NEAR revoke.  

## Reproduction

```powershell
cd E:\near-intent-one
node scripts/gate-h.mjs
# Ledger (local interactive only):
node scripts/ledger/01-print-owner-keys.mjs
# follow scripts/ledger/02–05 with physical device
```
