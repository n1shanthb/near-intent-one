# Checkpoint J8B-R — Recover successful on-chain proposal after false local failure

**HARD STOP held:** no Ledger, unpause, propose, request_signature, broadcast, funding, on-chain reconcile, or create-recovery-auth.

## Incident

| Field | Value |
|-------|--------|
| Operation | `j8b-canary-1794572720062-8db4f42a` |
| Parent NEAR tx | `HnpL7Sh2E7QPSi4rq1sefDQV4nYayFnKpkvbU2NUdzad` |
| Receipt | `HKvxVGMZ9VwsEmDzmDmLdPsJ9og2G5Cx7HVLgDZGm45P` |
| Exact digest | `b1811f74b1c61a67a9f0d80dfabbdd14e46904d5585f847b80c49801ea0640ed` |
| Local (wrong) | `FAILED` / `used=true` / `consume_reason=payload_commitment_mismatch` |
| On-chain | `signing_state=Reserved`, `settlement_state=None`, paused=true |

## Final fail-closed hardening

1. `verifyNearProposeReceipt` requires tx success + agent→policy signer/receiver + parsed `EVENT_JSON` `quoted_evm_reserved` with exact `operation_id` and digest from this tx's outcomes. Success alone / hash alone / text mention is NO-GO.
2. `canaryStepSettle` fails closed on recovery MAC / binding failures. `SETTLEMENT_PENDING` alone does not bypass. Used recovery allowed only with bound `locked_broadcast_hash`.
3. Auth TTL stays STRICT for sign/broadcast. Post-broadcast settlement evidence may continue after TTL only with valid HMAC + exact op/digest + original fingerprint + `SETTLEMENT_PENDING` + bound broadcast hash; still requires Arb receipt + 1Click terminal + Base Δ≥994904.

## Live zero-mutation rehearsal (parent tx)

```
verdict: SAFE_TO_RESUME_ORIGINAL_OPERATION
mutations_invoked: false
near_receipt.independently_verified: true
signer_id: agent.nishanthb.near
receiver_id: policy.nishanthb.near
has_quoted_evm_reserved: true
recovery_auth_exists: false
```

## Operator resume (separate approvals; never re-propose)

```powershell
node scripts/mainnet/canary-operator.mjs inspect --op j8b-canary-1794572720062-8db4f42a --near-tx HnpL7Sh2E7QPSi4rq1sefDQV4nYayFnKpkvbU2NUdzad
node scripts/mainnet/canary-operator.mjs recovery-rehearsal --op j8b-canary-1794572720062-8db4f42a --near-tx HnpL7Sh2E7QPSi4rq1sefDQV4nYayFnKpkvbU2NUdzad
# Only if SAFE:
node scripts/mainnet/canary-operator.mjs create-recovery-auth --op j8b-canary-1794572720062-8db4f42a --near-tx HnpL7Sh2E7QPSi4rq1sefDQV4nYayFnKpkvbU2NUdzad --confirm-recovery
```

## Tests

`83/83` pass — j8b0 + j8b1 + j8br + j8br.e2e + agentBackend

## Verdict

**PASS** — fail-closed recovery path ready; resume existing Reserved op only after separate create-recovery-auth.
