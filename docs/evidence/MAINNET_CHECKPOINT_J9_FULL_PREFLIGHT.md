# Checkpoint J9 — Full multichain preflight (no funding)

**Mutations invoked:** false  
**Hard stop:** funding / Ledger / unpause / propose / sign / broadcast / autonomous funded trading

Baseline: `d641fe8`

## 1. Ethereum → NEAR (Mission 1)

- **Verdict:** NO-GO / `AWAITING_FUNDING`
- Destination: NEAR NEP-141 USDC (not wrap.near)
- Dry min_out: `990418` policy=PASS
- Est L1 fee ≈ $0.35 (OK)
- **Blockers:** mpc_eth_usdc_insufficient:have=0:need=1000000; mpc_ethereum_native_eth_zero; near_usdc_storage_unregistered:owner_must_storage_deposit_before_receive

## 2. Base → Ethereum (Mission 2)

- **Verdict:** NO-GO — **STRUCTURAL** (not a simple funding gap)
- Live Base USDC: `997398` (J8B leftover rechecked; **do not top up for M2**)
- Live withdrawFee on Base→Eth quotes: ~`300000` raw (0.30 USDC) → amount_out ≈ in − 0.30 USDC
- Policy floor at max_slippage 100 bps + max_trade 5 USDC: **1–5 USDC quotes all BLOCKED**
- Reduced 0.5 USDC attempt also BLOCKED (worse ratio)
- Dry min_out (attempt): `198898` policy=BLOCKED
- **Blockers:** mpc_base_native_eth_zero; policy_slippage_floor_rejects_min_out:min=198898:floor=495000; structural_withdraw_fee:300000_raw_usdc_vs_max_trade_5usdc_likely_unpassable
- **Deferral:** leave Base USDC idle; discovery alternatives: base→near_usdc (PASS), eth→base (PASS). Mandate change or different destination needs separate approval.

## 3. Other route feasibility (discovery only)

Scoped funded routes remain **only** Eth→NEAR and Base→Eth.

| Route | Feasibility | Policy | Gaps |
|-------|-------------|--------|------|
| eth_usdc_to_near_usdc | QUOTE_OK | PASS | requires_eth_l1_gas_funding |
| base_usdc_to_eth_usdc | POLICY_BLOCKED | BLOCKED | policy_floor:BLOCKED |
| arb_usdc_to_base_usdc | QUOTE_OK | PASS | — |
| arb_usdc_to_eth_usdc | POLICY_BLOCKED | BLOCKED | policy_floor:BLOCKED |
| eth_usdc_to_base_usdc | QUOTE_OK | PASS | requires_eth_l1_gas_funding |
| base_usdc_to_near_usdc | QUOTE_OK | PASS | — |
| eth_usdc_to_wrap_near | QUOTE_OK | PASS | decimals:UNSAFE_LOOSE_SLIPPAGE, requires_eth_l1_gas_funding |
| near_usdc_to_eth_usdc | POLICY_BLOCKED | BLOCKED | near_origin_evm_canary_executor_unsupported, policy_floor:BLOCKED |

## 4. Consolidated funding checklist

| Chain | Asset | Recipient | Current | Needed | Top-up | Buffer / note | From |
|-------|-------|-----------|---------|--------|--------|---------------|------|
| ethereum | USDC | `0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4` | 0 | 1 | 1 | exact 1 USDC canary — no excess USDC required | owner EOA / exchange → MPC Ethereum |
| ethereum | ETH | `0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4` | 0 | 0.0005 | 0.0005 | 3× live fee est (0.0000432436012 ETH ≈ $0.14) with 0.0005 ETH floor | owner EOA → MPC Ethereum |
| base | USDC | `0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4` | 0.997398 | 0 | 0 | NO top-up — Mission2 Base→Eth structurally fails policy at ≤5 USDC due to ~0.30 USDC withdraw fee | n/a — leave existing Base USDC idle until route/mandate change |
| base | ETH | `0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4` | 0 | 0 | 0 | Deferred with Mission2 — no Base gas needed until M2 unblocked | n/a |
| near | NEAR (storage_deposit) | `nishanthb.near` | 0 | 0.00125 | 0.00125 | exact storage_balance_bounds.min for NEAR native USDC NEP-141 | nishanthb.near signs storage_deposit (Ledger) — uses account NEAR balance |
| arbitrum | USDC/ETH | `0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4` | undefined | 0 | 0 | J8B complete — no Arb top-up for scoped missions | n/a |

**Totals:** Eth USDC +1, Eth gas +0.0005 ETH (≈$1.60), Base USDC +0, Base gas +0 ETH, NEAR storage 0.00125 NEAR. M2 strategy: `defer_mission2_structural_policy_block`.

## 5. Paper trading

- Funded autonomous: **DISABLED** (gates ok=true)
- Proposed limits (inactive): max 1 USDC/trade, 5 USDC daily notional, 1 USDC daily loss, kill switch
- Shadow results: m1_eth_usdc_to_near_usdc:PAPER_SKIP, m2_base_usdc_to_eth_usdc:PAPER_SKIP

## 6. Approvals required from owner

- Coordinated funding per funding.rows / totals
- NEAR USDC storage_deposit for nishanthb.near (Ledger)
- New Mission1 operation approval (never reuse J8B)
- New Mission2 operation approval (never reuse J8B)
- Per-mission Ledger unpause window + propose/sign/broadcast
- Per-mission reconcile_pending after settlement verify
- Any expansion beyond Eth→NEAR and Base→Eth funded scope
- Any autonomous funded trading (currently DISABLED)

MPC: `0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4`  
Owner: `nishanthb.near`
