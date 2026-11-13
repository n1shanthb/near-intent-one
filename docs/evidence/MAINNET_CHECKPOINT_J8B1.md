# Checkpoint J8B-1 — Final one-shot live execution hardening

**HARD STOP: NO Ledger / NO unpause / NO propose / NO request_signature / NO EVM broadcast / NO funding / NO autonomous**

## Readiness

**READY** for first owner-approved trade (operator sequential CLI). Not auto-executable.

## 1. Real production adapter status

| Adapter | Module | Status |
|---------|--------|--------|
| `propose_quoted_evm_transfer` | `packages/mainnet/canaryAdapters.mjs` | Real agent.nishanthb.near ops key path; not auto-invoked |
| `request_signature` (1 yocto) | same | Real; finality via `EXPERIMENTAL_tx_status` |
| MPC assemble + recover | `assembleEip155FromMpcNearTx` | Verifies recovered == funded MPC; digest vs PendingOp |
| EIP-155 serialize + Arb broadcast | adapters + `durableBroadcast.mjs` | Persist signed bytes before send |
| Base USDC settlement | `verifyBaseUsdcDelta` required before SETTLED | Invoked in `canaryStepSettle` |
| `reconcile_pending` | adapter + `canaryStepReconcilePending` | Separate confirm after SETTLED |

No mocked success adapters on production path. `testHarness` fixtures are test-only.

## 2. One-shot state-machine test results

```
node --test packages/mainnet/j8b0.canary.test.mjs packages/mainnet/j8b1.hardening.test.mjs packages/mainnet/agentBackend.test.mjs
# tests 46 / pass 46 / fail 0
```

States: PREPARED → QUOTE_VERIFIED → ATTESTED → OWNER_UNPAUSED → PROPOSED → MPC_SIGNED → READY_TO_BROADCAST → BROADCASTED → SETTLEMENT_PENDING → SETTLED → RECONCILED (or REFUNDED/FAILED).

## 3. Signature and broadcast validation evidence

- Malicious `signedRawHex` alone cannot bypass MPC assemble (`near_sign_adapter_missing` / pending).
- Opaque prevalidated unlock rejected; disk revalidation required (`resolveCanaryUnlock`).
- Broadcast requires `operationId`; refuses `signed_bytes_mismatch_no_resign` on crash replay with different bytes.
- Concurrent `tryClaimExecution` blocks second worker.

## 4. Durable journal and recovery evidence

- Signed raw persisted via `txJournal.markSigned` before any `eth_sendRawTransaction`.
- UNKNOWN/timeout → reconcile chain; `may_resign: false`.
- Restart with different bytes → refused.

## 5. Source/destination settlement checks

- Source: Arbitrum receipt + USDC Transfer MPC→escrow amount 1000000.
- 1Click SUCCESS alone insufficient.
- Base (8453) native USDC delta ≥ minAmountOut required for SETTLED.
- Late/pending settlement remains SETTLEMENT_PENDING.
- Policy `reconcile_pending` is a separately confirmed mutation.

## 6. Operator PowerShell workflow (one phase per command)

```powershell
# Store under ~/.nio-secure/mainnet-canary — set HMAC / ops key env as needed
cd E:\near-intent-one

# 0) Zero-mutation rehearsal
node scripts/mainnet/canary-operator.mjs dry-rehearsal

# 1) Prepare one-shot approval
node scripts/mainnet/canary-operator.mjs prepare
# note operation_id from output → $Op

# 2) Preview quote + attest (read/quote path; no propose)
node scripts/mainnet/canary-operator.mjs quote --op $Op
# Review escrow, amounts, gas, digest locks

# 3) Owner Ledger unpause — PRINT ONLY until approved
node scripts/mainnet/canary-operator.mjs show-unpause
# Uses $NioArgsFile (not $ARGS). DO NOT run until owner ready.

# 4) Verify on-chain paused=false
node scripts/mainnet/canary-operator.mjs verify-unpaused --op $Op

# 5) Confirm propose AFTER reviewing unpause outcome
node scripts/mainnet/canary-operator.mjs confirm --op $Op --phase propose
node scripts/mainnet/canary-operator.mjs propose --op $Op          # dry
# node scripts/mainnet/canary-operator.mjs propose --op $Op --invoke  # LIVE

# 6) Confirm sign AFTER propose outcome
node scripts/mainnet/canary-operator.mjs confirm --op $Op --phase sign
node scripts/mainnet/canary-operator.mjs sign --op $Op
# node scripts/mainnet/canary-operator.mjs sign --op $Op --invoke     # LIVE
# Review recovered MPC signer + local tx hash

# 7) Confirm broadcast AFTER sign persistence
node scripts/mainnet/canary-operator.mjs confirm --op $Op --phase broadcast
node scripts/mainnet/canary-operator.mjs broadcast --op $Op
# node scripts/mainnet/canary-operator.mjs broadcast --op $Op --invoke # LIVE

# 8) Pause ASAP after broadcast (do not leave window open for settlement poll)
node scripts/mainnet/canary-operator.mjs show-pause
node scripts/mainnet/canary-operator.mjs verify-paused

# 9) Settlement + optional reconcile
node scripts/mainnet/canary-operator.mjs settle --op $Op
node scripts/mainnet/canary-operator.mjs confirm --op $Op --phase reconcile
# node scripts/mainnet/canary-operator.mjs reconcile --op $Op --evidence <hash> --invoke
```

## 7. Remaining blockers

- Owner must physically Ledger-sign unpause/pause.
- Live ops credential path must be present on operator machine (`agent.nishanthb.near`).
- Attestor key file must match registered CANARY_ATTESTOR_PK.
- First trade still requires fresh 1Click quote within approval TTL.
- Residual: pause does not invalidate already-exported MPC ECDSA.

## 8. Scope lock (unchanged)

- Owner: nishanthb.near · Policy: policy.nishanthb.near · Agent: agent.nishanthb.near
- Epoch: 2 · Chain: 42161 · Amount: 1000000 · Autonomous: false
- Arb USDC → Base USDC · recipient/refund = funded MPC

## 9. Verdict

**READY** — wiring + tests complete; **NOT** auto-live. First trade only via sequential owner-approved CLI steps above.
