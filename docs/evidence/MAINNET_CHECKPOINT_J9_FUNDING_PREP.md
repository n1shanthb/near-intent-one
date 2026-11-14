# Checkpoint J9 ? Coordinated funding preparation (RO)

**Mutations invoked:** false  
**Policy paused:** true  
**J8B:** Success / RECONCILED / untouched  

Baseline: `e51eed92be1696699703fb5b9accd2d2b9b4a4fe`

## Live shortfalls (recomputed)

| Need | Current | Shortfall |
|------|---------|-----------|
| Eth USDC 1.0 | 0 | **1.0 USDC** |
| Eth ETH 0.0005 | 0 | **0.0005 ETH** (fee est ~$0.02; buffer OK) |
| Base USDC | 0.997398 | **0** (reuse) |
| Base ETH 0.0001 | 0 | **0.0001 ETH** (fee est ~$0.002; buffer OK) |
| NEAR USDC storage | unregistered | **0.00125 NEAR** (owner has ~2.73 NEAR) |

## Proposed transactions (NOT authorized)

1. **T1** Ledger `storage_deposit` on `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` as `nishanthb.near` ? 0.00125 NEAR, registration_only
2. **T2** Owner wallet/exchange: 1 USDC (Eth) ? MPC
3. **T3** Owner wallet/exchange: 0.0005 ETH (Eth) ? MPC
4. **T4** Owner wallet/exchange: 0.0001 ETH (Base) ? MPC

**STOP** ? approve each transaction explicitly before initiation.
