# P0 — Destination custody investigation (Tidepool SUCCESS trade)

**Verdict: CUSTODY FAILURE** — provider SUCCESS does not equal NIO-controlled custody.

## Trade under investigation

| Field | Value |
|-------|-------|
| Source (Sepolia) | `0x8bf6d1d8a252bf54054d140d5b8e5ae2e83e60ba85cf6f6efc8fe41dd2e2422a` |
| Destination (NEAR) | `BtguMNjeFE59vJqqWm1RGwvodQhzs6gVjnGUcfL6bvNk` |
| Amount out (provider) | `263247070370370421104000` (~0.263 wNEAR) |

## Exact quote fields used

| Field | Value |
|-------|-------|
| recipient | `0x30af279bedef3bb82c7f47bb9f6a514f6264e752` (MPC EVM) |
| recipientType | `DESTINATION_CHAIN` |
| destinationAsset | `nep141:wnear.tidepool-sandbox.testnet` |
| depositType | `ORIGIN_CHAIN` |
| refundTo | same EVM address |
| intentsAccount | `a4f0342b9e57ccda81a120067320e8ec86a77d4d4e21fc34375f77b1bfb05343` |

## Where the assets actually went

Receipt path on destination tx:

1. `verifier.tidepool-sandbox.testnet` — `mt_burn` / withdraw of wNEAR from `intentsAccount`
2. `wnear.tidepool-sandbox.testnet` — `ft_transfer`  
   `verifier` → **`0x30af279bedef3bb82c7f47bb9f6a514f6264e752`**  
   amount **`263247070370370421104000`**

| Check | Result |
|-------|--------|
| Output recipient | `0x30af279bedef3bb82c7f47bb9f6a514f6264e752` |
| Output contract | `wnear.tidepool-sandbox.testnet` |
| Balance interface | NEP-141 `ft_balance_of` (not policy `mt_balance_of`) |
| `ft_balance_of(0x30af…)` | `7313347300037944920013600` (includes prior misdeliveries) |
| Policy / owner `ft_balance_of` | `0` |
| Verifier `mt_balance_of` (recipient & intentsAccount) | `0` |
| NEAR `view_account(0x30af…)` | **UNKNOWN_ACCOUNT** |
| Access keys | none |

## Ownership / control

- The EVM-derived `intentsAccount` is a **transient verifier ledger id**, not an NIO-signable NEAR account. Balance was withdrawn immediately.
- MPC EVM key control on Sepolia **does not** create NEAR authority over account id `0x30af…`.
- Attempted `create_account` via testnet registrar → **`OnlyImplicitAccountCreationAllowed`** (tx `3JmS1FC5JUMXA8ntbUkuUcJQYAZJjsNgm4UeaRjUtWoA`).
- **Withdrawal feasibility: IMPOSSIBLE for NIO** without token-contract / Tidepool admin intervention.
- **Recovered funds: none.**

## Settlement verdict

**CUSTODY FAILURE.** Do not repeat EVM address + `DESTINATION_CHAIN` for NEAR NEP-141 destinations.

## Corrected next configuration

- `recipient` = `nio-i-a4e7-a-owner.testnet` (owner FullAccess)
- `recipientType` = `DESTINATION_CHAIN`
- `refundTo` = MPC EVM (origin refund only)
- Owner `storage_deposit` on wNEAR completed: `Ebffv3GND4e9EECBiAWsndwr3spUJVHPZpHpAfi5dVHv`
