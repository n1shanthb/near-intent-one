# GATE G — Ledger Ownership + Accounting Hardening

Date: 2026-11-09  
Network: NEAR **testnet** only (no mainnet funds)  
Artifacts: `evidence/live/gate-g-evidence.json`, `gate-g-fixup.json`, `gate-g-verify-state.json`  
Scripts: `scripts/gate-g-accounting-ledger.mjs`, `scripts/gate-g-fix-f1-leftover.mjs`, `scripts/ledger/*`  
Preserved: F1 owner-pinned attestor trust limitation; E3 post-revocation EVM execution finding

## Verdicts

| Check | Status |
|-------|--------|
| G accounting (F2 reserved / unresolved) | **PASS** |
| G `reconcile_pending` trust model | **PASS** |
| G narrow reconciler / watchdog | **PASS** |
| G Ledger ownership (physical) | **BLOCKED** |
| Overall Gate G | **BLOCKED** (hardware path incomplete) |

Accounting and reconciler work passed. Ledger hardware confirmation was not performed — Gate G remains **BLOCKED** until physical device steps complete.

---

## 1. F2 reserved exposure — exact operation

F2 post-reconciliation snapshot had `reserved_pending_exposure=1000000`, `unresolved_pending=1`.

| Field | Value |
|-------|-------|
| Operation | `f1-1794229262329` |
| Signing | `Reserved` |
| Settlement (pre-G) | `None` |
| Amount | `1000000` |
| Destination | `0x6826bb3985832850fbbbc8034c3f8906b7c4bd62` |
| Epoch | 13 |
| Origin | Abandoned pre-F1 probe leftover (successful F1 op was `f1-1794229311568`, later Expired) |

**Verdict before cleanup:** **CORRECTLY_PENDING** — not incorrectly stuck in a false terminal state. MPC never signed (`Reserved`/`None`), so no exportable ECDSA and no Sepolia tx exists. The reservation honestly held exposure.

**Cleanup (honest terminal, not fabricated Success):**

| Item | Value |
|------|-------|
| Actor | reconciler = `nio-c-agent-857107.testnet` |
| Method | `reconcile_pending(Expired, evidence_hash)` |
| NEAR tx | `9MeJmCE5b1nzcdK6fMMft8vMx6Nx5GizYYWQZDDDzqUE` |
| Evidence hash stored | `never-signed:Reserved/None:abandoned-f1-probe` |
| Event | `verified_onchain: false` |

**Final snapshot:**

```json
{
  "reserved_pending_exposure": "0",
  "realized_exposure": "2000000",
  "unresolved_pending": 0,
  "economically_settled": true,
  "mandate_epoch": 17,
  "revoked": false
}
```

---

## 2. `reconcile_pending` trust audit

| Claim | Finding |
|-------|---------|
| What the contract stores | `evidence_hash` bytes under `evh:<operation_id>` |
| What the contract verifies on-chain | **Nothing** against Sepolia/Tidepool |
| Event flag | `verified_onchain: false` always |
| Who may call | **owner** or owner-pinned **reconciler** |
| Why trusted | Off-chain watchdog must verify receipts (Sepolia `status=0x1` and/or Tidepool terminal + NEAR tx hashes) **before** calling; the hash is an audit pointer, not a proof |

**Actors**

| Actor | Can reconcile? | Can `set_policy` / `revoke`? |
|-------|----------------|------------------------------|
| Owner | Yes | Yes |
| Reconciler (`set_reconciler`) | Yes | **No** (agent `set_policy` rejected) |
| Agent without reconciler role | No | No |
| Contract self | `mark_settlement` via callback path | No |

**Configured reconciler:** `nio-c-agent-857107.testnet`  
**set_reconciler tx:** `9WiY2DoBGUmNf6jGV6DtrREYVceRmCf7QQNXfdvj7fqo`

---

## 3. Narrow watchdog (F4 owner key replacement)

F4 used the unrestricted software owner key for post-settle `reconcile_pending`. Gate G replaces that for routine ops:

1. Owner calls `set_reconciler(agent)` once.
2. Agent/watchdog verifies receipts off-chain, then calls `reconcile_pending`.
3. Agent **cannot** `set_policy` / `revoke` / `unrevoke` / `pause`.

Demo: reconciler Expired `f1-1794229262329`; subsequent agent `set_policy` **rejected**.

---

## 4. Ledger ownership — BLOCKED

Physical Ledger confirmation was **not** performed in this session. Software FullAccess remains.

| Item | Status |
|------|--------|
| Owner account | `nio-c-owner-857107.testnet` |
| Access keys now | 1× FullAccess `ed25519:9itHoXewdGq3fK8DYmHwoo32MdP3QdjJpgPPamxTNvvt` |
| Ledger FullAccess added | **No** |
| Ledger `set_policy` tx | **null** (BLOCKED) |
| Ledger `revoke` tx | **null** (BLOCKED) |
| Software key removed | **No** (must not remove until Ledger proven) |
| Seed phrases | Never requested |

**Safe sequence (prepared under `scripts/ledger/`):**

1. Connect Ledger Nano, open NEAR app (testnet).
2. Identify/confirm correct NEAR public key.
3. **ADD** Ledger FullAccess while software key still present.
4. Physically confirm testnet `set_policy`.
5. Physically confirm testnet `revoke`.
6. **Only then** delete software FullAccess (signed by Ledger).
7. Verify owner can still govern via Ledger alone.

Instructions: `01-print-owner-keys.mjs`, `02-add-ledger-key.INSTRUCTIONS.md`, `03-ledger-set-policy-revoke.INSTRUCTIONS.md`, `04-remove-software-key.INSTRUCTIONS.md`.

---

## 5. Preserved limitations

| Finding | Status |
|---------|--------|
| F1: Tidepool maker signatures not independently verified; trust = owner-pinned attestor | **Preserved** |
| E3: NEAR mandate revoke does **not** invalidate already-exported ECDSA; tx `0x90d4c64517f0e54082516a84ad0d9cf23a5671ea2e7f8877809615e894367199` mined after revoke | **Preserved** |

---

## 6. Access-key audit

```
nio-c-owner-857107.testnet
  ed25519:9itHoXewdGq3fK8DYmHwoo32MdP3QdjJpgPPamxTNvvt  FullAccess  (software)
  (Ledger FullAccess — not yet added)
```

---

## 7. Contract upgrade (Gate G)

| Item | Value |
|------|-------|
| Deploy tx | `DVebPWbFoiz7rjZWuZioAWUa57Kkf1AsU8pavyFCqBr` |
| New surface | `list_pending`, `set_reconciler`, `get_reconciler`, `clear_reconciler`, evidence storage on `reconcile_pending` |

---

## Reproduction

```powershell
cd E:\near-intent-one\contracts\policy
$env:CARGO_HOME='E:\toolchains\cargo'; $env:RUSTUP_HOME='E:\toolchains\rustup'
cargo build --target wasm32-unknown-unknown --release
cd E:\near-intent-one
node scripts/gate-g-accounting-ledger.mjs
# After diagnosing abandoned never-signed leftover:
node scripts/gate-g-fix-f1-leftover.mjs
node scripts/gate-g-verify-state.mjs
# Hardware (local, interactive — not in agent env):
node scripts/ledger/01-print-owner-keys.mjs
# then follow scripts/ledger/02–04 instructions with physical Ledger
```
