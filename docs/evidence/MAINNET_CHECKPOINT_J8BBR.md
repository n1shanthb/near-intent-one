# Checkpoint J8B-BR — Broadcast-only reauthorization for journaled signed tx

**HARD STOP held:** no Ledger unpause, propose, request_signature, raw EVM broadcast, settlement reconcile, or create-broadcast-reauth during development.

## Live operation

| Field | Value |
|-------|--------|
| Operation | `j8b-canary-1794572720062-8db4f42a` |
| NEAR signing tx | `27VQYinCZFddL6aXzyajktex6dbEJsjjVdUVD5KjsPVp` |
| NEAR propose tx | `HnpL7Sh2E7QPSi4rq1sefDQV4nYayFnKpkvbU2NUdzad` |
| Journal local_tx_hash | `a4d159fec8eca4e7bed01c6ed3b25e65ded7519dce47f9fd422fb6e9a55c9664` |
| Digest | `b1811f74b1c61a67a9f0d80dfabbdd14e46904d5585f847b80c49801ea0640ed` |
| Signed-recovery | READY_TO_BROADCAST, **expired** `2026-11-13T15:19:10.290Z` (immutable; never renewed) |

## Read-only live inspect

```
verdict: SAFE_TO_CREATE_BROADCAST_REAUTH
mutations_invoked: false
policy_paused_onchain: true
mandate_epoch: 2 / pending.epoch: 2
signing_state: Signed / settlement_state: None
journal: SIGNED, local hash + recovered MPC + digest/escrow/amount/gas match
arb_nonce: latest=0 pending=0, available
quote: PENDING_DEPOSIT, deadline fresh, min_out=994904
broadcast_reauth_exists: false
```

## What this unlocks (separately confirmed)

Short-lived `one_shot_mainnet_canary_broadcast_reauth_v1` auth that:
- forbids propose, request_signature, resign, and tx mutation
- binds exact journal local_tx_hash + digest
- never extends signed-recovery TTL
- never auto-broadcasts on create
- marks journal UNKNOWN on ambiguous RPC (no automatic second send)

## Next safe operator command

```powershell
node scripts/mainnet/canary-operator.mjs inspect-broadcast-reauth `
  --op j8b-canary-1794572720062-8db4f42a `
  --near-tx 27VQYinCZFddL6aXzyajktex6dbEJsjjVdUVD5KjsPVp `
  --propose-tx HnpL7Sh2E7QPSi4rq1sefDQV4nYayFnKpkvbU2NUdzad

# Only if still SAFE_TO_CREATE_BROADCAST_REAUTH:
node scripts/mainnet/canary-operator.mjs create-broadcast-reauth `
  --op j8b-canary-1794572720062-8db4f42a `
  --near-tx 27VQYinCZFddL6aXzyajktex6dbEJsjjVdUVD5KjsPVp `
  --propose-tx HnpL7Sh2E7QPSi4rq1sefDQV4nYayFnKpkvbU2NUdzad `
  --confirm-broadcast-reauth
```

After create: `confirm --phase broadcast` → `broadcast` (dry) → separate unpause window → `broadcast --invoke`. Never `request_signature` again for this operation.

## Tests

`122/122` pass — j8b0 + j8b1 + j8br + j8br.e2e + j8bs + j8br.broadcast-reauth + txJournal

## Verdict

**PASS** — broadcast-only reauth path ready; create only after fresh inspect SAFE.
