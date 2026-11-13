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
| Min out (dry) | `990430` |
| Est. source fee | ~0.000129 ETH (≈$0.41) |

Destination is **not** `wrap.near`, native NEAR, or an intents balance id.

## Live checks

- 1Click tokens: eth_usdc=true, near_usdc=true
- Policy paused=true, epoch=2, eip155:1=true
- MPC ETH wei=0, USDC raw=0, nonce=0/0
- NEAR USDC storage registered=false
- Dry quote policy fit=PASS

## Blockers

- mpc_eth_usdc_insufficient:have=0:need=1000000
- mpc_ethereum_native_eth_zero
- near_usdc_storage_unregistered:owner_must_storage_deposit_before_receive

## Warnings

- wrap.near_is_listed_but_not_selected — Mission 1 uses NEP-141 USDC (6 decimals), not wrap.near (24)

## Approval boundary

Stopped before any funded mutation. Explicit owner approval required for funding, storage registration, new operation auth, unpause window, propose/sign/broadcast, and reconcile.
