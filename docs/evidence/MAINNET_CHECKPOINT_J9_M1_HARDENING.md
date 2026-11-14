# Checkpoint J9 — Mission 1 final production safety hardening

**Mutations invoked:** false  
**Baseline:** `8769c4d98018c0492ad4ff39a7f31f520fe492f7`  
**Evidence commit:** `ee7b09c146ccfae433f771b86a65578ab78e9b88`  
**Hard stop:** no Ledger / unpause / propose / request_signature / broadcast / swap / reconcile / expiring approval

## Verdict

**READY_FOR_SEPARATE_FINANCIAL_APPROVAL**

## Defects fixed

- propose: require PendingOp verify; ambiguous → RECONCILIATION_REQUIRED, no resubmit
- sign: require observed MPC digest (no default to expected); no repeat on ambiguity
- persist: decode+verify Eth USDC transfer, chainId 1, amount 1e6, lock raw+hash
- broadcast: live nonce, journal binding, quote deadline, auth locks, pending check, UNKNOWN→reconcile-only
- reconcile: require Success + evidence hash + policy pause verify before RECONCILED
- trusted live RPC state; fixtures require testHarness
- phase confirmations state-gated (no advance booking)
- lifecycle advance results checked before claiming stage
- Mission1 CLI + Eth adapters independent of J8B Arb operator

## Tests

`node --test packages/mainnet/mission1.executor.e2e.test.mjs` — pass (happy path + negative/ambiguous)

## Wiring proof

- CLI: `scripts/mainnet/mission1-operator.mjs` exists=true
- Adapters: `mission1_view_adapters_v1` ethRpc=`https://ethereum-rpc.publicnode.com`
- Runner assert ok=true
- Path audit ok=true
- Fixture injection blocked in prod=true
- Independent of J8B=true

## Live state (read-only)

- Policy paused=true epoch=2
- TLS ok=true fortinet_mitm=false authorized=true
- Preflight ok=true
- Paper funded disabled=true

## Approval boundaries (remaining)

- Owner separate financial approval for Mission1 Eth→NEAR canary (not yet created)
- Ledger unpause() only after financial approval + attest window
- Operator confirm propose/sign/broadcast at correct lifecycle states only
- Ledger reconcile_pending only after SETTLED + evidence hash verified
- No reuse of J8B Arb approval or Arbitrum operator path
- Autonomous funded paper trading remains DISABLED
- Do not extend expired authorization TTL

See JSON: `MAINNET_CHECKPOINT_J9_M1_HARDENING.json`
