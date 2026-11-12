# Four-chain mainnet policy preflight (pre-AddKey / pre-deploy)

**Network:** mainnet · **Funded trading:** OFF · **WASM changed:** No

## Denomination mismatch (exact)

On-chain `max_trade_value`, `daily_turnover_limit`, and `max_pending_exposure` compare **raw `amount_in` units** with **no USD normalization and no per-asset decimals**.

| If amount_in asset | `max_trade_value=5000000` means |
|--------------------|----------------------------------|
| USDC/USDT (6 dec) | **5.0 tokens** |
| WETH (18 dec) | **5e-12 ETH** (dust — fail-closed) |
| wNEAR (24 dec) | **5e-18 wNEAR** (dust — fail-closed) |

**Implication:** A single shared raw cap cannot safely express “$5 max” across mixed decimals.  
**Minimal safe approach without WASM change:** treat caps as **USDC-6 raw units**; keep high-decimal assets on the allowlist mainly as **destination** legs; NEAR-origin / WETH-origin size is fail-closed until USD-normalized or per-asset caps ship.

`token_scope` remains **`allowlist`**. `ANY_ELIGIBLE_TOKEN` stays blocked for funded EVM.

## Canonical allowlist (live 1Click catalog)

| Chain | Asset | assetId | decimals | contract |
|-------|-------|---------|----------|----------|
| Ethereum | USDC | `nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near` | 6 | `0xa0b86991…eb48` |
| Arbitrum | USDC | `nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near` | 6 | `0xaf88d065…5831` |
| Base | USDC | `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near` | 6 | `0x833589fc…2913` |
| NEAR | USDC | `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` | 6 | native USDC contract |
| NEAR | USDT | `nep141:usdt.tether-token.near` | 6 | `usdt.tether-token.near` |
| NEAR | wNEAR | `nep141:wrap.near` | 24 | `wrap.near` |
| Ethereum | WETH | `nep141:eth-0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2.omft.near` | 18 | `0xc02aaa39…6cc2` |
| Arbitrum | WETH | `nep141:arb-0x82af49447d8a07e3bd95bd0d56f35241523fbab1.omft.near` | 18 | `0x82af4944…bab1` |
| Base | WETH | `nep141:base-0x4200000000000000000000000000000000000006.omft.near` | 18 | `0x4200…0006` |

Chains in mandate: `near`, `eip155:1`, `eip155:42161`, `eip155:8453`.

## Recipient / refund control

| Role | Value at init |
|------|----------------|
| NEAR destination / owner | `nishanthb.near` |
| EVM recipient / refund (MPC) | **Not yet derived** — add via owner `set_policy` after deploy + Chain Signatures derive |
| Arbitrary EVM deposits | **Forbidden** |

## Funded execution readiness (signing primitive)

| Origin | Routes in matrix | `may_use` funded signing |
|--------|------------------|---------------------------|
| Ethereum | 4 | classified ready (still needs MPC addr, balances, unpause, flags) |
| Arbitrum | 4 | same |
| Base | 4 | same |
| NEAR | 6 | **false** — NEP-141 path separate from EVM MPC |

Quoted discovery ≠ funded readiness. All mainnet funded flags remain OFF.

## NEAR-origin gap

`requiredSigningPrimitive(near)` → `NEAR_NATIVE_FT_TRANSFER_OR_STORAGE`, `may_use: false`.  
Do not use the EVM ERC-20 MPC transfer path for NEAR-native deposits.

## WASM

Unchanged: `3bc7c1120a1f593a4c96ff58171ce9521f780ceec0427d97f90f0cac9ecc4f90` (625701 bytes).  
Init still sets **`paused=true`**.
