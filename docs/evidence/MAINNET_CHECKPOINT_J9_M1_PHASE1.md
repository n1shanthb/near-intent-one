# Mission 1 Phase 1/2 — Live transaction report (STOP before NEAR mutation)

**Mutations invoked:** false  
**Baseline:** `f2f13daccdc7bea17ba7d3277ce8a1ff86e1344f`  
**Phase:** PHASE_2_AWAITING_OWNER_NEAR_MUTATION_APPROVAL

## Fresh authorization

| Field | Value |
|-------|--------|
| Operation ID | `m1-canary-1794631150799-fe3b430a` |
| Expires | `2026-11-14T04:59:10.801Z` (TTL 20 min) |
| Lifecycle | `ATTESTED` |
| Amount | 1 USDC (`1000000`) |
| Chain | Ethereum `1` / USDC `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` |
| MPC signer | `0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4` |
| Deposit address | `0x407a7C4013EEbd3e5D398a76B8d943C4F49C7100` |
| Destination | NEP-141 USDC → `nishanthb.near` |
| Refund | `0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4` on Ethereum |
| Min out | `994799` |
| Nonce | `0` |
| Gas price / limit | `196999377` / `75679` |
| Max fee | `14908715851983` wei (~0.00001491 ETH) |
| Digest | `33ccf724a7d9810091bcb2fd594e630bb7297a374afc1971cfcb43f849bb78ac` |
| NEAR USDC before | `0` |

## Policy / gates

- paused=true epoch=2 attestor_trusted=true
- TLS ok=true fortinet=false
- Paper funded disabled=true
- Existing pending ops: 1

## APPROVAL BOUNDARY

**STOP.** No Ledger unpause / propose / request_signature / broadcast yet.

Reply with explicit approval to proceed with **Owner-Ledger `unpause()` for operation `m1-canary-1794631150799-fe3b430a` only**, then physical Ledger confirmation.
