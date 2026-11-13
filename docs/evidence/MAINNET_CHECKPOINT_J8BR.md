# Checkpoint J8B-R — Recover successful on-chain proposal after false local failure

**HARD STOP held:** no Ledger, unpause, propose, request_signature, broadcast, funding, or on-chain reconcile.
**Recovery auth not created yet** — code path fixed first; create-recovery-auth is a separate operator step.

## Incident

| Field | Value |
|-------|--------|
| Operation | `j8b-canary-1794572720062-8db4f42a` |
| NEAR propose tx | `HKvxVGMZ9VwsEmDzmDmLdPsJ9og2G5Cx7HVLgDZGm45P` |
| Local (wrong) | `FAILED` / `used=true` / `consume_reason=payload_commitment_mismatch` |
| On-chain (authoritative) | `signing_state=Reserved`, `settlement_state=None`, digest match, amount=1000000, paused=true |

Root cause: immediate `get_pending` null after successful `quoted_evm_reserved` was treated as digest mismatch and the approval was consumed.

## J8B-R FINAL integration fixes

1. **Recovery broadcast authorization** — `durableBroadcast` / `resolveCanaryUnlock` / funded gate accept `allowRecovery` only for the same Reserved op + fingerprint + exact digest; does not unlock general mainnet broadcast.
2. **Quote economics** — recovery auth copies/binds deadline, minOut `994904`, quote hash, escrow, dest/refund, Base baseline, digest/nonce/gas; both auth TTL and 1Click deadline remain enforced.
3. **Settle / reconcile** — resume via `resolveWritableApproval` recovery record; original FAILED/used unchanged; lifecycle PROPOSED→…→RECONCILED with real receipt / 1Click SUCCESS / Base Δ≥minOut; owner/reconciler checks retained.
4. **Evidence integrity** — HMAC binds recovery kind, original fingerprint, proposal tx hash, `forbids_propose=true`; inspect requires independently verified NEAR receipt (not hash-as-proof); pre-`request_signature` rechecks Reserved / commitment / epoch / unpaused.

## Live zero-mutation rehearsal (this host)

```
verdict: SAFE_TO_RESUME_ORIGINAL_OPERATION
checks: all match (Reserved, digest, epoch=2, amount, deposit, paused, no broadcast, no MPC)
recovery_auth_exists: false
mutations_invoked: false
```

## Operator resume (after LIVE_RECOVERY_PATH_READY; still requires separate approvals)

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

```
node --test packages/mainnet/j8b0.canary.test.mjs packages/mainnet/j8b1.hardening.test.mjs packages/mainnet/j8br.recovery.test.mjs packages/mainnet/j8br.recovery.e2e.test.mjs packages/mainnet/agentBackend.test.mjs
→ 69/69 pass
```

## Verdict

**LIVE_RECOVERY_PATH_READY** — resume the existing Reserved operation only via recovery auth after create-recovery-auth; never re-propose; keep paused until a separately approved live resume window.
