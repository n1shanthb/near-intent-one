# NIO open-universe AI trading architecture

**Date:** 2026-11-11  
**Funded mainnet signing:** DISABLED  
**Default token scope:** ALLOWLIST (ANY_ELIGIBLE_TOKEN requires explicit owner auth)

## 1. Product model

NIO is a Ledger-governed autonomous agent across:

| Chain | CAIP-2 / id |
|-------|-------------|
| NEAR mainnet | `near` |
| Ethereum | `eip155:1` |
| Arbitrum One | `eip155:42161` |
| Base | `eip155:8453` |

Modes:

- **ALLOWLIST** — exact canonical asset ids only  
- **ANY_ELIGIBLE_TOKEN** — dynamic addresses on selected chains, still bound by limits/venues/risk/policy decode  

Pipeline: `DISCOVERED → RESEARCHED → RISK_CHECKED → QUOTEABLE → MANDATE_ALLOWED → ECONOMICALLY_VIABLE → APPROVED_FOR_EXECUTION`

## 2. Hardcoded / fixed-token assumptions (current locations)

| Location | Assumption |
|----------|------------|
| `packages/gate-k/constants.mjs` | Sepolia USDC + Tidepool OMFT pair |
| `scripts/lib/near-live.mjs` | Tidepool testnet verifier/assets |
| `apps/web/src/policy/schema.ts` `KNOWN_ASSETS` | Testnet OMFT ids |
| `apps/web/src/policy/compile.ts` | Symbol-based NL compiler (USDC/ETH/NEAR) |
| `packages/gate-j/*` demo | Fixed demo portfolio `i-a-a4e7` |
| Policy cancel/withdraw (pre-fix) | Hardcoded Sepolia `11155111` — **updated** to `allowed_chains` |

## 3. Mandate schema

Code: `packages/mandate/schema.mjs`

- Canonical ids: `eip155:<id>:0x…`, `nep141:…`, `native:near`, `native:eip155:<id>`  
- Separate `allowed_assets` / `allowed_assets_out`  
- Venues: `near_intents_1click`, `evm_0x`, `near_native_dex`  
- Validation rejects symbol-only allowlists and implicit ANY mode  

## 4. On-chain enforcement audit

| Requirement | Current WASM (updated) | Gap |
|-------------|------------------------|-----|
| Allowlist exact assets | YES | Symbols still accepted if owner puts them in list — compiler must emit canonical ids |
| ANY_ELIGIBLE_TOKEN by chain | YES (`token_scope` + `allowed_chains`) | Off-chain risk engine not yet wired into propose path |
| Four-chain IDs | YES via `allowed_chains` | — |
| EVM digest binds to/token/amount/chain/gas | YES (`propose_quoted_evm_transfer`) | ERC-20 **transfer** only — not arbitrary router calldata |
| Arbitrary aggregator calldata decode | NO | Must not sign undecoded 0x txs (`validateEvmAggregatorTx`) |
| NEAR-native method/receiver bind | Partial (intent payload checks) | Full NEP-141 swap venue bind TBD |
| No acceptance override | Off-chain + docs | Keep forbidden |

**STOP deploy note:** Current frozen WASM sha256 `6fd1912f5912f52481f788ee0a4f7fec1cbc3cafd34496d53e61feb59c1a30d1` (624900 B). Do **not** deploy older hashes. Still **not approved** for broadcast.

## 5. Discovery + execution

| Module | Role |
|--------|------|
| `packages/discovery` | Multi-source discover + stage machine + LLM shortlist |
| `packages/execution/router.mjs` | Adapter interface; 1Click shell; 0x/NEAR DEX stubs return UNSUPPORTED |

## 6. Feasible before Nov 14 vs longer-term

**Feasible now**

- Mandate schema + policy fields + tests  
- Honest four-chain UI (no fake balances/LIVE)  
- Discovery/router interfaces  
- Keep testnet demo intact; mainnet signing OFF  

**Longer-term**

- Production 0x (or equivalent) with calldata decode + bounded allowance  
- NEAR-native DEX adapter + storage registration  
- Full token risk engine (honeypot/tax/blacklist)  
- Autonomous unattended loop  
- Funded mainnet canary  

## 7. Security tests

- `packages/mandate/mandate.test.mjs`  
- Policy: `any_eligible_token_permits_chain_member_not_arbitrary`, wrong-chain panic  
- `validateEvmAggregatorTx` rejects unlimited approval / undecoded data  
