# Mainnet evidence log

**Rule:** No fabricated explorer links. No testnet receipts relabeled as mainnet.  
**Updated:** 2026-11-11

## Label legend

| Label | Meaning |
|-------|---------|
| IMPLEMENTED | Code/path exists in repo |
| DEPLOYED | On-chain deploy tx confirmed |
| VERIFIED ON MAINNET | Independent mainnet RPC/API read succeeded |
| DRY_QUOTE_OBTAINED | Production dry quote returned (no deposit) |
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
| Unit tests | IMPLEMENTED | `cargo test` → **28 passed** (quoted-EVM binding + ANY/gas/replay) |
| Release WASM | IMPLEMENTED | `artifacts/mainnet/policy.wasm` |
| WASM sha256 | IMPLEMENTED (not deployed) | `aa301524d9cfa99cbf0948d8e65f5f137411d494da91805770314fc6801b0202` (**625565** B) — supersedes `6fd1912f…30d1` |
| Mainnet deploy tx | **NOT YET PROVEN** | Awaiting Ledger owner account + explicit approval |
| Mainnet contract address | **NOT YET PROVEN** | Prefer `policy.<owner>.near` |
| Mainnet policy state views | **NOT YET PROVEN** | post-deploy |

## 3. Chain Signatures (mainnet)

| Item | Label | Evidence |
|------|-------|----------|
| Signer config `v1.signer` | IMPLEMENTED | `packages/mainnet/mpc.mjs` |
| Root `public_key` read | **VERIFIED ON MAINNET** | via `https://rpc.mainnet.near.org` |
| ECDSA address derivation | **VERIFIED ON MAINNET** (address only) | canary path derive |
| Funded `sign()` request | **NOT YET PROVEN** | `NIO_MAINNET_ALLOW_SIGN=0` |
| Completed mainnet signature | **NOT YET PROVEN** | |

## 4. Production NEAR Intents (1Click)

| Item | Label | Evidence |
|------|-------|----------|
| Client + production adapter | IMPLEMENTED | `intents.mjs`, `intents.production.mjs` |
| API base | IMPLEMENTED | `https://1click.chaindefuser.com` |
| Token registry | **VERIFIED ON MAINNET** | 229 tokens; arb/eth USDC + wrap.near present |
| Dry quote | **DRY_QUOTE_OBTAINED** | `docs/MAINNET_1CLICK_DRY_QUOTE_EVIDENCE.json` — arb USDC → wNEAR, dry:true, no deposit |
| Quote binding / expiry / recipient checks | IMPLEMENTED | `bindQuoteToRequest`, unit tests |
| Funded quote / deposit | **NOT YET PROVEN** | Gated; dry quotes omit deposit address |
| SUCCESS/FAILED/REFUNDED settle | IMPLEMENTED (helpers) | No live deposit to poll |

## 5. Trade safety / canary

| Item | Label | Evidence |
|------|-------|----------|
| No acceptance override | IMPLEMENTED | `mainnetTradeSafetyCheck` tests |
| Funded canary trade | **NOT YET PROVEN** | |

## 6. Confirmed funded mainnet transactions

**None.** No mainnet funds spent; no deploy; no signing.

## 7. Public testnet demo

| Item | Label |
|------|-------|
| OCI / DuckDNS / Gate J demo-decide | Intact (testnet) |
| `GATE_K_ALLOW_SIGN` | Remains `0` on OCI |
