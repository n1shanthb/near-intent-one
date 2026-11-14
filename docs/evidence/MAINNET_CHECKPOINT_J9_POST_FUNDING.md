# Checkpoint J9 — Post-funding verification

**Mutations invoked:** false  
**Hard stop:** unpause / propose / sign / broadcast / swap / reconcile / mandate mods  
**Baseline:** `b0afa50e0b385f0952f157db427c118efc354263`

## Verdicts

| Mission | Verdict | Why |
|---------|---------|-----|
| Mission 1 Eth→NEAR | **NO-GO** | tokens_unavailable:tokens_tls_error; origin_eth_usdc_missing_from_1click; dest_near_usdc_missing_from_1click; dry_quote_failed:quote_tls_error; policy_slippage_floor_rejects_min_out:min=0:floor=990000; oneclick_tls_blocked:unable to verify the first certificate:fortinet_mitm=true |
| Mission 2 Base→NEAR | **NO-GO** | no_policy_compliant_amount:have=997398:shortfall_1usdc=2602:no_policy_compliant_amount_within_balance |

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
| Eth gas fee est | ≈$0.028264920706944 (OK) |
| Base gas fee est | ≈$0.0010424218294591999 (OK) |
| 1Click TLS | ok=false fortinet_mitm=true error=unable to verify the first certificate |

## Mission 1 approval preview (NOT an authorization)

- Suggested op id: `m1-canary-1794627634279-17954b95` (not persisted)
- Amount: 1 USDC (`1000000`) Eth native USDC → NEP-141 USDC @ `nishanthb.near`
- Signer: `0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4`
- Slippage request: 50 bps (policy max 100)
- Dry min_out: `0`
- Steps: Ledger unpause → propose_quoted_evm_transfer → request_signature → Eth broadcast → settle verify → Ledger reconcile → pause

## Engineering gaps

- canaryExecutor_default_steps_still_j8b_arb_bindings — use mission1ExecutionPath + operator confirmations; do not run J8B canary-operator against Eth→NEAR
- fresh_1click_quotes_require_non_fortinet_path_or_installed_fg_ca
- no_policy_compliant_amount:have=997398:shortfall_1usdc=2602:no_policy_compliant_amount_within_balance

## Production path components ready

- verifySourceUsdcTransfer_parameterized_for_ethereum
- verifyNearNep141Delta_production_nep141
- monitorOneClickByDeposit_by_deposit_address
- mission1_settlement_wrapper_wired
- durable_tx_journal_sqlite_available
- journal_duplicate_idempotency_blocked
- j8b_defaults_isolated_from_mission1_module
- mission1_approval_kind_separate_store
- mission1_transaction_plan_documented

Paper funded autonomous: **DISABLED** (ok=true)
