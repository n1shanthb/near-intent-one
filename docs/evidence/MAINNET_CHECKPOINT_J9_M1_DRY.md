# Checkpoint J9-M1-DRY — Ethereum → NEAR USDC canary preflight

**Mutations invoked:** false  
**Verdict:** **NO-GO**

## Proposed route (not authorized)

| Field | Value |
|-------|--------|
| Route | `m1_eth_usdc_to_near_usdc` |
| Amount | 1 USDC (`1000000`) |
| Source | Ethereum chain_id **1**, USDC `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` |
| Destination | NEAR **NEP-141 USDC** `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` |
| Signer (MPC) | `0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4` |
| Recipient | `nishanthb.near` |
| Refund | `0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4` on Ethereum |
| Quote slippage | 50 bps (policy max 100) |
| Min out (dry) | `0` |
| Est. source fee | ~0.000007 ETH (≈$0.02) |

Destination is **not** `wrap.near`, native NEAR, or an intents balance id.

## Live checks

- 1Click tokens: eth_usdc=false, near_usdc=false
- Policy paused=true, epoch=2, eip155:1=true
- MPC ETH wei=600000000000000, USDC raw=1200535, nonce=0/0
- NEAR USDC storage registered=true
- Dry quote policy fit=BLOCKED

## Blockers

- tokens_unavailable:tokens_tls_error
- origin_eth_usdc_missing_from_1click
- dest_near_usdc_missing_from_1click
- dry_quote_failed:quote_tls_error
- policy_slippage_floor_rejects_min_out:min=0:floor=990000

## Warnings

- (none)

## Approval boundary

Stopped before any funded mutation. Explicit owner approval required for funding, storage registration, new operation auth, unpause window, propose/sign/broadcast, and reconcile.
