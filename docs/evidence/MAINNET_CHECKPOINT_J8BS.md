# Checkpoint J8B-S — Recover existing on-chain MPC signature after local extraction failure

**HARD STOP held:** no Ledger unpause, propose, request_signature, EVM broadcast, on-chain reconcile, create-signed-recovery-auth, or persist-signed-raw --invoke.

## Incident

| Field | Value |
|-------|--------|
| Operation | `j8b-canary-1794572720062-8db4f42a` |
| Propose parent | `HnpL7Sh2E7QPSi4rq1sefDQV4nYayFnKpkvbU2NUdzad` |
| Signing parent | `27VQYinCZFddL6aXzyajktex6dbEJsjjVdUVD5KjsPVp` |
| Expected local tx hash | `a4d159fec8eca4e7bed01c6ed3b25e65ded7519dce47f9fd422fb6e9a55c9664` |
| MPC signer | `0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4` |
| On-chain | `Signed` / `None`, paused=true, epoch=2 |

## Persistence completion

1. `persist-signed-raw` (dry by default) recovers existing signed tx from the signing parent; never proposes / request_signature.
2. Requires unexpired signed-recovery auth + exact digest/signer/fingerprint/quote/gas/nonce/escrow bindings.
3. Cross-checks Signed/None, paused, **both** mandate+PendingOp epoch=2, proposal receipt when provided, Arb nonce/pending.
4. Cryptographically verifies raw bytes vs authorized `local_tx_hash`; journals encrypted; no raw logging.
5. Crash-safe / idempotent; conflicting journal bytes → NO-GO.
6. Advances only signed-recovery auth `MPC_SIGNED → READY_TO_BROADCAST` after successful persist.
7. Broadcast remains separately confirmed with deadline/TTL/gate checks; signed-recovery unlock supported without relaxing gates.

## Live read-only inspection

```
verdict: SAFE_TO_CREATE_SIGNED_TX_RECOVERY_AUTH
mutations_invoked: false
epoch_match (mandate AND pending): true
propose_receipt_ok: true
recovered: 0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4
digest: b1811f74…40ed
local_tx_hash: a4d159fe…9664
candidate_count: 2 / unique_count: 1
arb mpc_nonce/pending: 0 / 0
raw signature/tx bytes: not returned
```

## Exact safe operator commands (NOT executed)

```powershell
# 1) Re-verify (read-only)
node scripts/mainnet/canary-operator.mjs inspect-signed-recovery `
  --op j8b-canary-1794572720062-8db4f42a `
  --near-tx 27VQYinCZFddL6aXzyajktex6dbEJsjjVdUVD5KjsPVp `
  --propose-tx HnpL7Sh2E7QPSi4rq1sefDQV4nYayFnKpkvbU2NUdzad

# 2) Create short-lived signed-recovery auth (separate approval)
node scripts/mainnet/canary-operator.mjs create-signed-recovery-auth `
  --op j8b-canary-1794572720062-8db4f42a `
  --near-tx 27VQYinCZFddL6aXzyajktex6dbEJsjjVdUVD5KjsPVp `
  --propose-tx HnpL7Sh2E7QPSi4rq1sefDQV4nYayFnKpkvbU2NUdzad `
  --confirm-signed-recovery

# 3) Dry-run persist, then persist with confirm
node scripts/mainnet/canary-operator.mjs persist-signed-raw `
  --op j8b-canary-1794572720062-8db4f42a `
  --near-tx 27VQYinCZFddL6aXzyajktex6dbEJsjjVdUVD5KjsPVp `
  --propose-tx HnpL7Sh2E7QPSi4rq1sefDQV4nYayFnKpkvbU2NUdzad

node scripts/mainnet/canary-operator.mjs persist-signed-raw `
  --op j8b-canary-1794572720062-8db4f42a `
  --near-tx 27VQYinCZFddL6aXzyajktex6dbEJsjjVdUVD5KjsPVp `
  --propose-tx HnpL7Sh2E7QPSi4rq1sefDQV4nYayFnKpkvbU2NUdzad `
  --confirm-persist --invoke

# 4) Later, separate unpause + confirm broadcast + broadcast --invoke (not this checkpoint)
```

Never `request_signature` again. Do not extend prior recovery TTL.

## Tests

`104/104` pass — j8b0 + j8b1 + j8br + j8br.e2e + j8bs + agentBackend

## Verdict

**PASS** — persistence path ready; live state unchanged; create/persist/broadcast still require separate operator approvals.
