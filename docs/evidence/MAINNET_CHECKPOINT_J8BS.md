# Checkpoint J8B-S — Recover existing on-chain MPC signature after local extraction failure

**HARD STOP held:** no Ledger unpause, propose, request_signature, EVM broadcast, on-chain reconcile, create-recovery-auth, or create-signed-recovery-auth.

## Incident

| Field | Value |
|-------|--------|
| Operation | `j8b-canary-1794572720062-8db4f42a` |
| Propose parent | `HnpL7Sh2E7QPSi4rq1sefDQV4nYayFnKpkvbU2NUdzad` |
| Signing parent | `27VQYinCZFddL6aXzyajktex6dbEJsjjVdUVD5KjsPVp` |
| Signing receipt | `CKNyt3L68pvt9hSYWPQew5QNSk6ntgZe3ZVH3fGfjTvg` |
| Digest | `b1811f74b1c61a67a9f0d80dfabbdd14e46904d5585f847b80c49801ea0640ed` |
| On-chain | `Signed` / `None`, paused=true, epoch=2 |
| Local | prior recovery `FAILED` after `MPC_SIG_NOT_FOUND`; no broadcast |

Root cause: `extractMpcSigFromNearTx` only read `result.receipts_outcome`; live RPC returns top-level `receipts_outcome` (8 outcomes, 2 identical MPC SuccessValues).

## Fixes

1. Extract supports wrapped + unwrapped RPC; duplicate identical OK; conflicting/malformed → NO-GO.
2. Read-only `inspect-signed-recovery` verifies signer/receiver, Signed/None, digest, signed event, recovered MPC `0xee82…7cd4`, exact tx fields, Arb nonce.
3. Separate short-lived `signed-recovery-{op}.json` auth forbids propose + request_signature; preserves both FAILED records; does not persist raw tx until a later explicit step.

## Live read-only inspection

```
verdict: SAFE_TO_CREATE_SIGNED_TX_RECOVERY_AUTH
mutations_invoked: false
recovered: 0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4
digest: b1811f74…40ed
local_tx_hash: a4d159fe…9664
candidate_count: 2 / unique_count: 1
arb mpc_nonce: 0 (available)
raw signature/tx bytes: not returned
```

## Next safe operator action (NOT executed)

```powershell
node scripts/mainnet/canary-operator.mjs create-signed-recovery-auth `
  --op j8b-canary-1794572720062-8db4f42a `
  --near-tx 27VQYinCZFddL6aXzyajktex6dbEJsjjVdUVD5KjsPVp `
  --propose-tx HnpL7Sh2E7QPSi4rq1sefDQV4nYayFnKpkvbU2NUdzad `
  --confirm-signed-recovery
```

Then a separate approved persist-signed-raw / broadcast window. **Never** `request_signature` again. Do not extend the prior recovery TTL.

## Tests

`94/94` pass — j8b0 + j8b1 + j8br + j8br.e2e + j8bs + agentBackend

## Verdict

**PASS** — extracted-signature verification SAFE; ready for separately confirmed signed-tx recovery auth only.
