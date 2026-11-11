# Mainnet evidence log

**Rule:** No fabricated explorer links. No testnet receipts relabeled as mainnet.  
**Updated:** 2026-11-11

## Label legend

| Label | Meaning |
|-------|---------|
| IMPLEMENTED | Code/path exists in repo |
| DEPLOYED | On-chain deploy tx confirmed |
| VERIFIED ON MAINNET | Independent mainnet RPC/API read succeeded |
| FUNDED EXECUTION PROVEN | Real value moved and settled |
| NOT YET PROVEN | Missing or gated |

---

## 1. Network isolation

| Item | Label | Evidence |
|------|-------|----------|
| Separate profiles | IMPLEMENTED | `packages/networks/profiles.mjs` |
| Mainnet gates default OFF | IMPLEMENTED | `mainnetAuthGates()` unit tests |
| Public demo stays testnet | IMPLEMENTED | `api-server.mjs` refuses non-testnet |

## 2. Policy contract

| Item | Label | Evidence |
|------|-------|----------|
| Unit tests | IMPLEMENTED | `cargo test` → **18 passed** (2026-11-11) |
| Release WASM | IMPLEMENTED | `contracts/policy/target/.../policy.wasm` |
| WASM sha256 | IMPLEMENTED (frozen, not deployed) | `6fd1912f5912f52481f788ee0a4f7fec1cbc3cafd34496d53e61feb59c1a30d1` (624900 B) — open-universe fields; supersedes prior hashes |
| Mainnet deploy tx | **NOT YET PROVEN** | Blocked: target account unresolved + no mainnet deployer creds |
| Mainnet contract address | **NOT YET PROVEN** | `nio-policy-hack26.near` = UNKNOWN_ACCOUNT |
| Mainnet policy state views | **NOT YET PROVEN** | `verifyDeployedPolicy()` ready post-deploy |

## 3. Chain Signatures (mainnet)

| Item | Label | Evidence |
|------|-------|----------|
| Signer config `v1.signer` | IMPLEMENTED | `packages/mainnet/mpc.mjs`, NEAR docs |
| Root `public_key` read | **VERIFIED ON MAINNET** | `secp256k1:3tFRbMqmoa6AAALMrEFAYCEoHcqKxeW38YptwowBVBtXK1vo36HDbUWuR6EZmoK4JcH6HDkNMGGqP1ouV7VZUWya` via `https://rpc.mainnet.near.org` |
| ECDSA address derivation | **VERIFIED ON MAINNET** (address only) | predecessor `nio-policy-hack26.near` path `trading/v1/portfolio/hack26-canary` → EVM `0x9751874dc251d705ed571a447f7a00de5b845cf4` |
| Funded `sign()` request | **NOT YET PROVEN** | `NIO_MAINNET_ALLOW_SIGN=0` |
| Completed mainnet signature | **NOT YET PROVEN** | Derived address ≠ signature |

## 4. Production NEAR Intents (1Click)

| Item | Label | Evidence |
|------|-------|----------|
| Client integration | IMPLEMENTED | `packages/mainnet/intents.mjs` |
| API base | IMPLEMENTED | `https://1click.chaindefuser.com` |
| Token registry | **VERIFIED ON MAINNET** | 229 tokens — `docs/MAINNET_1CLICK_TOKENS_SAMPLE.json` (arb USDC + `wrap.near` present) |
| Dry quote | **NOT YET PROVEN** | Code ready (`dry:true`); host got WAF 403 / needs `NIO_1CLICK_JWT` |
| Funded quote / deposit | **NOT YET PROVEN** | Gated `NIO_MAINNET_ALLOW_FUNDED_QUOTE` |
| SUCCESS/FAILED/REFUNDED settle | **NOT YET PROVEN** | Status normalizer ready; no deposit yet |

## 5. Trade safety / canary

| Item | Label | Evidence |
|------|-------|----------|
| No acceptance override | IMPLEMENTED | `mainnetTradeSafetyCheck` tests |
| Canary approval schema | IMPLEMENTED | `packages/mainnet/canary.mjs` |
| Funded canary trade | **NOT YET PROVEN** | Blocked until testnet lifecycle + Ledger + your approval |

## 6. Confirmed funded mainnet transactions

**None.** No mainnet funds spent by this workstream.

## 7. Public testnet demo

| Item | Label |
|------|-------|
| OCI / DuckDNS / Gate J demo-decide | Intact (testnet) |
| `GATE_K_ALLOW_SIGN` | Remains `0` on OCI |
| Settlement worker | Remains disabled |
