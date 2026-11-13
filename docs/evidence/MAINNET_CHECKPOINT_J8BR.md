# Checkpoint J8B-R — Recover successful on-chain proposal after false local failure

**HARD STOP held:** no Ledger, unpause, propose, request_signature, broadcast, funding, or on-chain reconcile.

## Incident

| Field | Value |
|-------|--------|
| Operation | `j8b-canary-1794572720062-8db4f42a` |
| NEAR propose tx | `HKvxVGMZ9VwsEmDzmDmLdPsJ9og2G5Cx7HVLgDZGm45P` |
| Local (wrong) | `FAILED` / `used=true` / `consume_reason=payload_commitment_mismatch` |
| On-chain (authoritative) | `signing_state=Reserved`, `settlement_state=None`, digest match, amount=1000000, paused=true |

Root cause: immediate `get_pending` null after successful `quoted_evm_reserved` was treated as digest mismatch and the approval was consumed.

## Fixes

1. Propose verification retries `get_pending` + `list_pending` with backoff; null → `RECONCILIATION_REQUIRED` (no consume, no resubmit); true mismatch still fails closed.
2. Read-only `inspect` / `recovery-rehearsal` (view-only adapters; no ops key required).
3. Original approval remains immutable when used; new `recovery-{op}.json` auth starts at `PROPOSED`, `forbids_propose=true`.
4. Abort path: owner Ledger `reconcile_pending(Failed, evidence)` printed only — not invoked.

## Live zero-mutation rehearsal (this host)

```
verdict: SAFE_TO_RESUME_ORIGINAL_OPERATION
checks: all match (Reserved, digest, epoch=2, amount, deposit, paused, no broadcast, no MPC)
recovery_auth_exists: false
mutations_invoked: false
```

## Operator resume (after this commit; still requires separate approvals)

```powershell
node scripts/mainnet/canary-operator.mjs inspect --op j8b-canary-1794572720062-8db4f42a --near-tx HKvxVGMZ9VwsEmDzmDmLdPsJ9og2G5Cx7HVLgDZGm45P
node scripts/mainnet/canary-operator.mjs recovery-rehearsal --op j8b-canary-1794572720062-8db4f42a --near-tx HKvxVGMZ9VwsEmDzmDmLdPsJ9og2G5Cx7HVLgDZGm45P
# Only if inspect verdict SAFE:
node scripts/mainnet/canary-operator.mjs create-recovery-auth --op j8b-canary-1794572720062-8db4f42a --near-tx HKvxVGMZ9VwsEmDzmDmLdPsJ9og2G5Cx7HVLgDZGm45P --confirm-recovery
# Keep policy paused until a separately approved unpause window, then:
# confirm --phase sign → sign [--invoke] → …  NEVER propose again
# Abort alternative (DO NOT run unless aborting):
node scripts/mainnet/canary-operator.mjs show-abort --op j8b-canary-1794572720062-8db4f42a
```

## Tests

`node --test packages/mainnet/j8br.recovery.test.mjs packages/mainnet/j8b1.hardening.test.mjs packages/mainnet/j8b0.canary.test.mjs` → **54/54 pass**

## Verdict

**SAFE_TO_RESUME_ORIGINAL_OPERATION** — via recovery authorization at post-propose only; never re-propose; keep paused until separate live resume approval.
