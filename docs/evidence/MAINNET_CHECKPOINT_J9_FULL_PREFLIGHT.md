# Checkpoint J9 — Full multichain preflight (Base→NEAR Mission 2)

**Mutations invoked:** false  
**Hard stop:** funding / Ledger / unpause / propose / sign / broadcast / autonomous funded trading

Baseline: `09b91b5`

## 1. Ethereum → NEAR (Mission 1)

- **Verdict:** NO-GO / `AWAITING_FUNDING`
- Dry min_out: `990442` policy=PASS
- **Blockers:** mpc_eth_usdc_insufficient:have=0:need=1000000; mpc_ethereum_native_eth_zero; near_usdc_storage_unregistered:owner_must_storage_deposit_before_receive

## 2. Base → NEAR USDC (Mission 2 — active)

- **Verdict:** NO-GO
- Live Base USDC: `997398` (J8B leftover rechecked)
- Proposed amount: **0.997398 USDC** (`997398`)
- Recipient: `nishanthb.near` — NEP-141 USDC (shared storage with M1, register once)
- Dry min_out: `987854` policy=PASS
- Base gas: OK ≈ $0.0010
- **Blockers:** near_usdc_storage_unregistered:shared_with_mission1_register_once; mpc_base_native_eth_zero
- **Warnings:** using_balance_capped_amount:997398_live_base_usdc=997398
- Base → Ethereum: **DEFERRED** (structural withdraw fee)

## 3. Other route feasibility

| Route | Feasibility | Policy | Scope |
|-------|-------------|--------|-------|
| eth_usdc_to_near_usdc | QUOTE_OK | PASS | mission1 |
| base_usdc_to_near_usdc | QUOTE_OK | PASS | mission2 |
| base_usdc_to_eth_usdc | POLICY_BLOCKED | BLOCKED | deferred |
| arb_usdc_to_base_usdc | QUOTE_OK | PASS | done_j8b |
| arb_usdc_to_eth_usdc | POLICY_BLOCKED | BLOCKED | discovery_only |
| eth_usdc_to_base_usdc | QUOTE_OK | PASS | discovery_only |
| eth_usdc_to_wrap_near | QUOTE_OK | PASS | discovery_only |
| near_usdc_to_eth_usdc | POLICY_BLOCKED | BLOCKED | discovery_only |

## 4. Consolidated funding checklist

| Chain | Asset | Recipient | Current | Needed | Top-up | Buffer / note | From |
|-------|-------|-----------|---------|--------|--------|---------------|------|
| ethereum | USDC | `0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4` | 0 | 1 | 1 | exact 1 USDC canary — no excess USDC required | owner EOA / exchange → MPC Ethereum |
| ethereum | ETH | `0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4` | 0 | 0.0005 | 0.0005 | 3× live fee est (0.000024838096 ETH ≈ $0.08) with 0.0005 ETH floor | owner EOA → MPC Ethereum |
| base | USDC | `0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4` | 0.997398 | 0.997398 | 0 | policy-compliant dry amount 997398 ≤ live balance; no USDC top-up | reuse MPC Base USDC (J8B leftover, live-verified) |
| base | ETH | `0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4` | 0 | 0.0001 | 0.0001 | 5× live Base fee est (6e-7 ETH ≈ $0.0019) with 0.0001 ETH floor | owner EOA → MPC Base |
| near | NEAR (storage_deposit) | `nishanthb.near` | 0 | 0.00125 | 0.00125 | Single storage_deposit for NEAR native USDC NEP-141 — covers both missions | nishanthb.near signs storage_deposit (Ledger) — uses account NEAR balance |
| arbitrum | USDC/ETH | `0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4` | undefined | 0 | 0 | J8B complete — no Arb top-up for scoped missions | n/a |

**Totals:** Eth USDC +1, Eth gas +0.0005 ETH, Base USDC +0, Base gas +0.0001 ETH, NEAR storage 0.00125 NEAR (once). M2: `reuse_base_usdc_997398_policy_pass_awaiting_gas_storage` @ 0.997398 USDC.

**Funding order:**
- 1) NEAR USDC storage_deposit on nishanthb.near (once, Ledger) — unlocks M1+M2 receive
- 2) Ethereum MPC: 1 USDC + 0.0005 ETH gas buffer
- 3) Base MPC: ETH gas buffer only (reuse live Base USDC if policy-compliant amount exists)
- 4) Separate Mission1 then Mission2 execution approvals after funding verified

## 5. Paper trading

- Funded autonomous: **DISABLED** (ok=true)
- Shadows: m1_eth_usdc_to_near_usdc:PAPER_SKIP, m2_base_usdc_to_near_usdc:PAPER_TAKE

## 6. Approvals required

- Coordinated funding per funding.rows / totals / funding_order
- ONE NEAR USDC storage_deposit for nishanthb.near (covers M1+M2)
- New Mission1 operation approval (never reuse J8B)
- New Mission2 Base→NEAR operation approval (never reuse J8B/M1)
- Per-mission Ledger unpause + propose/sign/broadcast
- Per-mission reconcile_pending after settlement verify
- Base→Eth remains DEFERRED without separate approval
- Autonomous funded trading remains DISABLED

MPC: `0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4`  
Owner: `nishanthb.near`
