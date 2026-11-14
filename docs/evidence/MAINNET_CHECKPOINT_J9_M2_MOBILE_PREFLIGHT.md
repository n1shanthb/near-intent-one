# Checkpoint J9 — Mission 2 mobile Wi-Fi preflight (READ-ONLY)

**Baseline:** `d389b664d7115ee50c3422418671c31f85ac1991`  
**Checked:** 2026-11-14T05:52:28.042Z  
**Mutations invoked:** false  
**Financial approval:** not created  
**Verdict:** **READY_FOR_SEPARATE_FINANCIAL_APPROVAL**

## TLS / routing

| Field | Value |
|-------|--------|
| secureFetch ok | true |
| authorized | true |
| Fortinet MITM | false |
| Issuer | Google Trust Services / WE1 |
| rejectUnauthorized | true |

## Live snapshot

| Field | Value |
|-------|--------|
| Base USDC | `997398` (0.997398) |
| Base ETH | ~0.000525245946414409 |
| Amount (capped) | `997398` (at balance and at cap) |
| Min out / amount out | `992210` / `997196` |
| Policy fit | **PASS** (floor `987424`) |
| Signature verified | true (hash `4LrgzkHPyaNAMW6fPaYHk4YoBLVaBKucPSUBsV6s85Rw`) |
| Deadline (dry) | 2026-11-14T06:07:26.355Z |
| Correlation | d8960e8c-caf1-404c-97b4-873125d2feac |
| Slip | 50 bps |
| Nonce | 0 / 0 |
| Gas economics | OK fee_eth=3.2706e-7 |
| Policy | paused=true epoch=2 |
| Storage | registered=true |
| J8B / M1 | Success / Success |
| Unresolved pending | 0 |
| Disk free | 3.19 GB |
| Runner | ok=true |

## Blockers

_None_

## Exact financial approval preview

- chainId **8453** Base native USDC `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`
- amount **997398** raw -> NEAR NEP-141 USDC @ `nishanthb.near`
- MPC/refund `0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4`
- min_out **992210** (policy PASS)
- CLI: `scripts/mainnet/mission2-operator.mjs` only

## Hard stop

No Mission 2 approval / unpause / propose / sign / broadcast / reconcile.  
Separate owner financial approval required before any mutation.
