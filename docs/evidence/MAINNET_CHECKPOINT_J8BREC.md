# Checkpoint J8B-REC — Owner-Ledger `reconcile_pending` after SETTLED broadcast

**HARD STOP held:** no unpause, `set_reconciler`, propose, MPC signing, EVM broadcast, or duplicate reconcile.

## Live operation

| Field | Value |
|-------|--------|
| Operation | `j8b-canary-1794572720062-8db4f42a` |
| Signer | `nishanthb.near` (Ledger HD `m/44'/397'/0'/0'/1'`) |
| Method | `reconcile_pending` on `policy.nishanthb.near` |
| Args | `settlement_state=Success`, `evidence_hash=6bb8b4703e374411285eb3eaecea0fc180ce3494bcbd485f26b976653bb88cf7` |
| NEAR reconcile tx | `EWLeboFnxdTeJK2VatMECPQCZXY9Q5vVyLBFNSboQdNq` |
| Prior Arb broadcast | `0x4e9583a86d9cc62dd508e72d5e6d965711ef7eeecce5422c42fa7fa37c0d6c48` |
| Prior Base fill | `0x2251df330813e77546d0e01ce15a7797b50871faa578fb8a597055f80da3b36f` |

## Pre-execution read-only checks (passed)

- Args file exact match for approved values
- PendingOp `Signed` / `settlement_state: None`
- `get_evidence_hash` null
- `get_reconciler` null → owner Ledger only
- Policy `paused=true`, mandate epoch `2`
- Local lifecycle `SETTLED` with bound broadcast hash
- No prior on-chain reconciliation

## On-chain verification (after submit)

| Check | Result |
|-------|--------|
| Receipt / final status | `FINAL` — tx `EWLeboFnxdTeJK2VatMECPQCZXY9Q5vVyLBFNSboQdNq` |
| Event `settlement` | `state=Success` |
| Event `reconciled` | evidence_hash matches approved value (`verified_onchain=false` = audit pointer, expected) |
| PendingOp settlement | `Success` |
| Stored evidence hash | `6bb8b4703e374411285eb3eaecea0fc180ce3494bcbd485f26b976653bb88cf7` |
| Policy paused | `true` |

## Local state

Advanced `SETTLED → RECONCILED` only after the on-chain verification above.

## Verdict

**PASS / RECONCILED** — single owner-Ledger `reconcile_pending` submitted once; on-chain settlement `Success`, evidence hash, and paused=true independently verified.
