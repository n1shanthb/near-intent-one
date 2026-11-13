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

## Approved execution outcome

The operator explicitly approved one broadcast of the exact existing signed
transaction. The short-lived authorization was created only after a fresh
read-only preflight:

| Field | Value |
|-------|-------|
| Authorization fingerprint | `367531716a4ad88edb130e31f40d841daa38e87c290c958f115e08c6fc394493` |
| Authorization expiry | `2026-11-13T15:50:39.586Z` |
| Arbitrum transaction | `0x4e9583a86d9cc62dd508e72d5e6d965711ef7eeecce5422c42fa7fa37c0d6c48` |
| Arbitrum receipt | success (`status=0x1`), 1,000,000 USDC transferred to the exact deposit |
| 1Click terminal status | `SUCCESS` |
| Base transaction | `0x2251df330813e77546d0e01ce15a7797b50871faa578fb8a597055f80da3b36f` |
| Base receipt | success (`status=0x1`) |
| Destination USDC | `997398` raw units (`0.997398 USDC`) |
| Required minimum | `994904` raw units (`0.994904 USDC`) |
| Local authorization state | `SETTLED`, used=true, exact broadcast hash bound |
| NEAR policy | paused=true (independently read after settlement) |
| NEAR PendingOp | Signed / None; on-chain reconciliation not invoked |

The first live CLI attempt stopped before submission because
`NIO_AGENT_OPS_KEY_PATH` was absent. Before retrying, the journal was verified
still `SIGNED`, nonce remained 0/0, and transaction/receipt were absent. The
single network submission then used the secured existing agent ops credential.

No Ledger signing, unpause, propose, request_signature, re-sign, replacement
swap, duplicate broadcast, or NEAR reconciliation mutation occurred.

## Tests

`122/122` pass — j8b0 + j8b1 + j8br + j8br.e2e + j8bs + j8br.broadcast-reauth + txJournal

## Verdict

**PASS / SETTLED** — exact existing transaction broadcast once; Arbitrum source
receipt, terminal 1Click result, and Base destination USDC independently
verified. Separate owner approval remains required before any NEAR
`reconcile_pending` mutation.
