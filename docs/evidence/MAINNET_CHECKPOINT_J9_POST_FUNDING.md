# Checkpoint J9 — Post-funding verification

**Mutations invoked:** false  
**Hard stop:** unpause / propose / sign / broadcast / swap / reconcile / mandate mods  
**Baseline:** `b0afa50e0b385f0952f157db427c118efc354263`

## Verdicts

| Mission | Verdict | Why |
|---------|---------|-----|
| Mission 1 Eth→NEAR | **READY** | funding+policy+quote clear |
| Mission 2 Base→NEAR | **READY** | ok |

## Live funding / policy

| Check | Value |
|-------|-------|
| Eth MPC USDC | 1200535 (≥1e6: true) |
| Eth MPC ETH | 0.0006 (≥0.0005: true) |
| Base MPC USDC | 997398 |
| Base MPC ETH | 0.000525245946414409 (≥0.0001: true) |
| NEAR USDC storage | registered=true |
| Policy paused | true epoch=2 |
| J8B pending | settlement=Success unresolved=0 |
| Eth gas fee est | ≈$0.020584084237056 (OK) |
| Base gas fee est | ≈$0.001046592 (OK) |
| 1Click TLS | ok=true fortinet_mitm=null error=none |

## Mission 1 approval preview (NOT an authorization)

- Suggested op id: `m1-canary-1794629538374-ab5d4ec2` (not persisted)
- Amount: 1 USDC (`1000000`) Eth native USDC → NEP-141 USDC @ `nishanthb.near`
- Signer: `0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4`
- Slippage request: 50 bps (policy max 100)
- Dry min_out: `994799`
- Steps: Ledger unpause → propose_quoted_evm_transfer → request_signature → Eth broadcast → settle verify → Ledger reconcile → pause

## Engineering gaps



## Production path components ready

- verifySourceUsdcTransfer_parameterized_for_ethereum
- verifyNearNep141Delta_production_nep141
- monitorOneClickByDeposit_by_deposit_address
- mission1_settlement_wrapper_wired
- near_usdc_before_snapshot_required
- durable_tx_journal_sqlite_available
- journal_duplicate_idempotency_blocked
- j8b_defaults_isolated_from_mission1_module
- mission1_approval_kind_separate_store
- mission1_transaction_plan_documented
- mission1_step_runner_complete
- mission1_executor_independent_of_j8b_arb

Paper funded autonomous: **DISABLED** (ok=true)
