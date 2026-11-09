# Ledger-authorize set_policy then revoke

Contract: `nio-c-policy-857107.testnet`
Sign as: `nio-c-owner-857107.testnet` **with Ledger only** (select Ledger key in CLI).

## set_policy

Submit owner `set_policy` with current limits / a new policy_hash (e.g. `gate-g-ledger-v1`).
Confirm on device. Record tx hash → `evidence/live/gate-g-ledger-set-policy.json`.

## revoke

Submit owner `revoke`. Confirm on device. Record tx hash → `evidence/live/gate-g-ledger-revoke.json`.

## Verify

```bash
near contract call-function as-read-only nio-c-policy-857107.testnet get_revocation_status json-args {} network-config testnet now
```

Expect `revoked: true` after Ledger revoke.
Then `unrevoke` via Ledger if you need to continue testing.

Never paste seed phrases into chat, files, or CI.
