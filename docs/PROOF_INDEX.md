# NIO Proof Index

Authoritative catalog of **verified** on-chain and marketplace evidence for NEAR HACKATHON judges.

**Rule:** Never invent a transaction hash. Labels below match local evidence JSON/MD. Where a hash is missing, status is `EVIDENCE NOT AVAILABLE`.

**Live mandate (read now):** https://nio-api-hack26.duckdns.org/mainnet/mandate — as of 2026-11-14 renew: **epoch 4**, $5/$25/$10, 200 bps, expires ~2026-11-24 UTC. Original autonomy activation was **epoch 3** ($1/$5/$2). Distinguish activation-time vs current.

---

## Legend

| Label | Meaning |
| --- | --- |
| **MAINNET** | NEAR / EVM mainnet |
| **TESTNET** | NEAR testnet / Sepolia |
| **SUPERVISED** | Owner Ledger involved in the financial path |
| **AUTONOMOUS** | Agent cycle under on-chain mandate (no per-trade owner approve) |
| **SETTLED** | Independent reconcile / Success |
| **DECISION VERIFIED** | On-chain audit receipt; may be NO_TRADE |
| **DRY RUN / SIMULATED / LOCAL ANVIL** | Not a funded mainnet settlement |

---

## A. First real mainnet canary — J8B

**MAINNET · SUPERVISED · SETTLED**

| Field | Value |
| --- | --- |
| What | Arbitrum USDC → Base USDC via NEAR MPC + Intents/1Click |
| Operation | `j8b-canary-1794572720062-8db4f42a` |
| Lifecycle | RECONCILED / Success |
| NEAR proposal | [HnpL7Sh2E7QPSi4rq1sefDQV4nYayFnKpkvbU2NUdzad](https://nearblocks.io/txns/HnpL7Sh2E7QPSi4rq1sefDQV4nYayFnKpkvbU2NUdzad) |
| NEAR MPC sign | [27VQYinCZFddL6aXzyajktex6dbEJsjjVdUVD5KjsPVp](https://nearblocks.io/txns/27VQYinCZFddL6aXzyajktex6dbEJsjjVdUVD5KjsPVp) |
| Arbitrum | [0x4e9583a86d9cc62dd508e72d5e6d965711ef7eeecce5422c42fa7fa37c0d6c48](https://arbiscan.io/tx/0x4e9583a86d9cc62dd508e72d5e6d965711ef7eeecce5422c42fa7fa37c0d6c48) |
| Base settlement | [0x2251df330813e77546d0e01ce15a7797b50871faa578fb8a597055f80da3b36f](https://basescan.org/tx/0x2251df330813e77546d0e01ce15a7797b50871faa578fb8a597055f80da3b36f) |
| NEAR reconcile | [EWLeboFnxdTeJK2VatMECPQCZXY9Q5vVyLBFNSboQdNq](https://nearblocks.io/txns/EWLeboFnxdTeJK2VatMECPQCZXY9Q5vVyLBFNSboQdNq) |
| Evidence | [`MAINNET_CHECKPOINT_J8BREC.json`](./evidence/MAINNET_CHECKPOINT_J8BREC.json), [`MAINNET_CHECKPOINT_J8BBR.md`](./evidence/MAINNET_CHECKPOINT_J8BBR.md) |
| Verification | Local evidence `lifecycle: RECONCILED`, `settlement_state: Success`, arb/base txs recorded |

---

## B. Mainnet Mission 1 — Ethereum → NEAR

**MAINNET · SUPERVISED · SETTLED** · **OWNER-SUPERVISED MAINNET INTENTS SETTLEMENT**

| Field | Value |
| --- | --- |
| What | Ethereum native USDC → NEAR NEP-141 USDC |
| Operation | `m1-canary-1794631150799-fe3b430a` |
| Amount in | 1,000,000 raw USDC (1 USDC) |
| NEAR delta | 999,798 raw |
| NEAR proposal | [FqgtwT3huJN3DCsDftDMJkrdrE8F7EBCYkChk6ugCTsU](https://nearblocks.io/txns/FqgtwT3huJN3DCsDftDMJkrdrE8F7EBCYkChk6ugCTsU) |
| NEAR MPC sign | [Aq1Hht1oJ5Rzm6tU21Q5W2WNr3uNXRxTmBtcMXTH484g](https://nearblocks.io/txns/Aq1Hht1oJ5Rzm6tU21Q5W2WNr3uNXRxTmBtcMXTH484g) |
| Ethereum | [0x9bc11fc2869cce36fa1ea1e7cb2ed0cf99917241719a841215ebb5466d7567aa](https://etherscan.io/tx/0x9bc11fc2869cce36fa1ea1e7cb2ed0cf99917241719a841215ebb5466d7567aa) |
| NEAR reconcile | [7mCCRb7YtdZewy6G4zksfMaycc3bo3MTWtDN7KHdSRZ3](https://nearblocks.io/txns/7mCCRb7YtdZewy6G4zksfMaycc3bo3MTWtDN7KHdSRZ3) |
| Evidence | [`MAINNET_CHECKPOINT_J9_M1_COMPLETE.md`](./evidence/MAINNET_CHECKPOINT_J9_M1_COMPLETE.md), [`MAINNET_CHECKPOINT_J9_M1_RECONCILED.json`](./evidence/MAINNET_CHECKPOINT_J9_M1_RECONCILED.json) |
| Verification | Evidence `lifecycle_state: SETTLED`, broadcast hash matches Etherscan link |

---

## C. Mainnet Mission 2 — Base → NEAR

**MAINNET · SUPERVISED · SETTLED** · **OWNER-SUPERVISED MAINNET INTENTS SETTLEMENT**

| Field | Value |
| --- | --- |
| What | Base native USDC → NEAR NEP-141 USDC |
| Operation | `m2-canary-1794636150765-ed31a108` |
| Amount in | 997,398 raw Base USDC |
| NEAR delta | 997,196 raw |
| NEAR proposal | [G4eytRAy8ktqFzJSqPpah6KLKuCxry21rJj77uMTfYGN](https://nearblocks.io/txns/G4eytRAy8ktqFzJSqPpah6KLKuCxry21rJj77uMTfYGN) |
| NEAR MPC sign | [JChcSuAsz73yswAcMbUJwTkQ2vLzbg7dCGWLj5mECPhr](https://nearblocks.io/txns/JChcSuAsz73yswAcMbUJwTkQ2vLzbg7dCGWLj5mECPhr) |
| Base | [0xdfbaf42bae71c74efce65f2be1f6553a2c424003e5386be82b70af828d6140e2](https://basescan.org/tx/0xdfbaf42bae71c74efce65f2be1f6553a2c424003e5386be82b70af828d6140e2) |
| NEAR reconcile | [E3g711GASJVM492hzeudRrfWjJrig4B9bh29nDFBqhK5](https://nearblocks.io/txns/E3g711GASJVM492hzeudRrfWjJrig4B9bh29nDFBqhK5) |
| Evidence | [`MAINNET_CHECKPOINT_J9_M2_COMPLETE.md`](./evidence/MAINNET_CHECKPOINT_J9_M2_COMPLETE.md), [`MAINNET_CHECKPOINT_J9_M2_RECONCILED.json`](./evidence/MAINNET_CHECKPOINT_J9_M2_RECONCILED.json) |
| Verification | Evidence `lifecycle: RECONCILED`, `settlement_state: Success` |

---

## D. Mainnet autonomy deployment & mandate

**MAINNET · OWNER-ACTIVATED · AUTONOMY ENABLED**

| Field | Value |
| --- | --- |
| Contract | [`policy.nishanthb.near`](https://nearblocks.io/address/policy.nishanthb.near) |
| Owner | `nishanthb.near` |
| Agent | `agent.nishanthb.near` |
| Portfolio | `nio-mainnet-v1` |
| Autonomy WASM deploy | [7rxXmYqbDL7HyBtG2EKo4g1xHbJYptphg9jMLU7Konrf](https://nearblocks.io/txns/7rxXmYqbDL7HyBtG2EKo4g1xHbJYptphg9jMLU7Konrf) |
| Migrate → state v1 | [3XHBXDPWMhmDymZdh4NrVZfxYwp9DqcbekLVVrxVSYME](https://nearblocks.io/txns/3XHBXDPWMhmDymZdh4NrVZfxYwp9DqcbekLVVrxVSYME) |
| Activate autonomous mandate (epoch 3) | [6zQs6C56tdPYz5BYY9Ca2T4XusU5oavt1gDw3tdDaW93](https://nearblocks.io/txns/6zQs6C56tdPYz5BYY9Ca2T4XusU5oavt1gDw3tdDaW93) |
| Unpause | [9jaW3jv5z2adx8aV6xXhfvCstxeKrRaQp2e8SEHX61Fy](https://nearblocks.io/txns/9jaW3jv5z2adx8aV6xXhfvCstxeKrRaQp2e8SEHX61Fy) |
| Judge renew (epoch 4, 10-day) | [GuBY2n5cH4oBnhQ4UNJXnqhHs4GKYzvsRoyi9jzdqpCt](https://nearblocks.io/txns/GuBY2n5cH4oBnhQ4UNJXnqhHs4GKYzvsRoyi9jzdqpCt) |
| Evidence | [`MAINNET_WASM_DEPLOYED.json`](./evidence/MAINNET_WASM_DEPLOYED.json), [`MAINNET_SHIP_STATUS.json`](./evidence/MAINNET_SHIP_STATUS.json), [`MAINNET_MANDATE_ACTIVE.json`](./evidence/MAINNET_MANDATE_ACTIVE.json) |

### At original activation (epoch 3)

- Max trade **$1** · daily **$5** · pending **$2** · slippage **100 bps**
- Autonomous trading ON · enforce on agent ON
- Chains: NEAR, Ethereum, Arbitrum, Base · venue `near_intents_1click`
- Exact token/destination allowlists on-chain

### Current live (epoch 4, after judge renew 2026-11-14)

- Max trade **$5** · daily **$25** · pending **$10** · slippage **200 bps**
- Expiry ~**2026-11-24 UTC** · unpaused · autonomous ON
- Same allowlists / destinations / venue family

**Not claimed:** continuous 24/7 keeper uptime; autonomous mainnet **settled swap**.

---

## E. Audit WASM + autonomous AI decision receipt

**MAINNET · AUTONOMOUS · DECISION VERIFIED · NO TRADE EXECUTED**

| Field | Value |
| --- | --- |
| Audit WASM deploy | [4oM5UGjwk8vtUzJ6cjo6bhY1zWaaGSMtD8c2LDC2Tb3G](https://nearblocks.io/txns/4oM5UGjwk8vtUzJ6cjo6bhY1zWaaGSMtD8c2LDC2Tb3G) |
| Migrate → state v2 | [CRUYyjdYMwfKzxpUBvcKXJtn5dvi7CH9zdocUawu2CFj](https://nearblocks.io/txns/CRUYyjdYMwfKzxpUBvcKXJtn5dvi7CH9zdocUawu2CFj) |
| First on-chain autonomous decision | [CXR4ey3x2x3scEhGeW8sRLnRAVsPrsYiRYFPcTAAAz1s](https://nearblocks.io/txns/CXR4ey3x2x3scEhGeW8sRLnRAVsPrsYiRYFPcTAAAz1s) |
| Decision | **NO_TRADE** |
| Fitter | **REJECTED** |
| Reason | **NO_OPPORTUNITY** |
| Events | research_completed · strategy_proposed · fitter_evaluated · critic_evaluated · decision_finalized |
| Evidence hash | `0df66baea166fc76dfe958993330516efc2d060ec46330264203beb02e588f10` |
| Evidence files | [`NO_TRADE_ONCHAIN_RECEIPT.json`](./evidence/NO_TRADE_ONCHAIN_RECEIPT.json), [`FITTER_VERDICT_ONCHAIN_RECEIPT.json`](./evidence/FITTER_VERDICT_ONCHAIN_RECEIPT.json), [`AUDIT_MAINNET_UPGRADE_STATUS.json`](./evidence/AUDIT_MAINNET_UPGRADE_STATUS.json) |

**Never** treat this as a settled autonomous trade.

---

## F. NEAR Agent Market — first real purchase

**REAL MARKETPLACE AGENT HIRED — 0.15 USDC ESCROWED — DELIVERY PENDING**

| Field | Value |
| --- | --- |
| Marketplace | https://market.near.ai |
| Job | https://market.near.ai/hiring/jobs/e0933c32-5494-45bc-8e7c-9b69a32e548c |
| Provider | `llmrt-onchain-research` |
| Price | **0.15 USDC** escrowed |
| Buyer balance | 0.999021 → 0.849021 USDC |
| Payment rail | Marketplace USDC escrow (**not** an individual NEAR L1 tx) |
| Status (verified 2026-11-14) | `in_progress` · `result_available: false` · worker still working |
| Evidence | [`COMMERCE_FIRST_PURCHASE_PAID.json`](./evidence/COMMERCE_FIRST_PURCHASE_PAID.json), [`COMMERCE_FIRST_PURCHASE_PAID.md`](./evidence/COMMERCE_FIRST_PURCHASE_PAID.md) |

Separate commerce budget from trading mandate. Escrow ≠ delivery.

---

## G. J18 — authentic testnet MPC → Sepolia ERC20

**TESTNET · DETERMINISTIC ERC20 TRANSFER · REAL MPC SIGNATURE · SETTLED · NOT INTENTS**

| Field | Value |
| --- | --- |
| What | NEAR testnet MPC-signed Sepolia ERC20 transfer (Tidepool test USDC) |
| Amount | 1,000,000 raw |
| NEAR testnet propose | [HUEj87p5ktWt1ekueXicMyrnFhcZCkriyfVa8A7UZRwo](https://testnet.nearblocks.io/txns/HUEj87p5ktWt1ekueXicMyrnFhcZCkriyfVa8A7UZRwo) |
| NEAR testnet MPC sign | [CgQaL5yDknUQG9AtoNbu2xvEPYF7MPz6W29n3ny3bUxF](https://testnet.nearblocks.io/txns/CgQaL5yDknUQG9AtoNbu2xvEPYF7MPz6W29n3ny3bUxF) |
| Sepolia ERC20 | [0xc9826ca6b7dc80f308fad18ff9ee136b9836907eb7df0ccdeb0f1ddf780c8b53](https://sepolia.etherscan.io/tx/0xc9826ca6b7dc80f308fad18ff9ee136b9836907eb7df0ccdeb0f1ddf780c8b53) |
| NEAR testnet reconcile | [3uU3cDxnBYAHUtNkrNn1UStZ2g7CndtsQDpKHVhjUGrZ](https://testnet.nearblocks.io/txns/3uU3cDxnBYAHUtNkrNn1UStZ2g7CndtsQDpKHVhjUGrZ) |
| Evidence | [`J18_SEPOLIA_SETTLEMENT_GO.json`](./evidence/J18_SEPOLIA_SETTLEMENT_GO.json) |
| Note | `intents_settlement: false` — deterministic transfer, not Intents swap |

---

## H. Other testnet / historical proofs (inventory)

| Item | Network / kind | Status | Notes / evidence |
| --- | --- | --- | --- |
| J13 live testnet policy + migration | TESTNET | Documented | [`J13_AUTONOMY_FINAL_REPORT.md`](./evidence/J13_AUTONOMY_FINAL_REPORT.md) |
| J14 Borsh upgrade rehearsal | TESTNET / local | Documented | `scripts/j14/`, evidence under `J14_*` |
| J16 authentic MPC `request_signature` | TESTNET | Documented | [`J16_MPC_EVM_TESTNET_ATTEMPT.json`](./evidence/J16_MPC_EVM_TESTNET_ATTEMPT.json) |
| J16 Anvil ERC20 | LOCAL ANVIL | Not mainnet | [`J16_ANVIL_ERC20_PROOF.json`](./evidence/J16_ANVIL_ERC20_PROOF.json) |
| J17 funding / quote signer | TESTNET | Documented | `J17_*` evidence pack |
| Gate I / J / K | Mostly testnet / dry | Historical | `docs/GATE_*`, sepolia Gate K |
| TESTNET_FUNDED_MULTICHAIN_TRADES | TESTNET | Documented | [`TESTNET_FUNDED_MULTICHAIN_TRADES.md`](./evidence/TESTNET_FUNDED_MULTICHAIN_TRADES.md) |
| J12 OpenRouter keeper cycles | MAINNET decision journal | NO_TRADE cycles | `J12_KEEPER_*` — not settled swaps |

For any milestone without a recorded explorer hash in evidence: **EVIDENCE NOT AVAILABLE**.

---

## Quick settlement table (mainnet Intents)

| Mission | Route | EVM tx | NEAR reconcile |
| --- | --- | --- | --- |
| **J8B** | Arbitrum → Base | [arbiscan](https://arbiscan.io/tx/0x4e9583a86d9cc62dd508e72d5e6d965711ef7eeecce5422c42fa7fa37c0d6c48) | [EWLebo…](https://nearblocks.io/txns/EWLeboFnxdTeJK2VatMECPQCZXY9Q5vVyLBFNSboQdNq) |
| **M1** | Ethereum → NEAR | [etherscan](https://etherscan.io/tx/0x9bc11fc2869cce36fa1ea1e7cb2ed0cf99917241719a841215ebb5466d7567aa) | [7mCCRb…](https://nearblocks.io/txns/7mCCRb7YtdZewy6G4zksfMaycc3bo3MTWtDN7KHdSRZ3) |
| **M2** | Base → NEAR | [basescan](https://basescan.org/tx/0xdfbaf42bae71c74efce65f2be1f6553a2c424003e5386be82b70af828d6140e2) | [E3g711…](https://nearblocks.io/txns/E3g711GASJVM492hzeudRrfWjJrig4B9bh29nDFBqhK5) |

All three: **OWNER-SUPERVISED MAINNET INTENTS SETTLEMENTS**.
