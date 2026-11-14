# J16 — Mainnet Activation Readiness

**Baseline:** `e8901f4`  
**HARD STOP:** No mainnet WASM upgrade, access-key change, mandate activation, unpause, Ledger signing, new mainnet MPC, EVM broadcast, funding, or financial operation. Mainnet policy remains paused.

## Gate matrix

| Gate | Verdict | Evidence |
|------|---------|----------|
| REAL_EVM_NODE_EXECUTION | **PASS** | Anvil local node — `J16_ANVIL_ERC20_PROOF.json` tx `0xb1da3550…` |
| AUTHENTIC_NEAR_MPC_SIGNATURE | **PASS** | Testnet `request_signature` — [NEAR tx](https://testnet.nearblocks.io/txns/9eaSHcVf1vCDHp9tntxFx4LvVLdzp7zxNfUs4uG362X); recovered `0x9a82c26b…` |
| REAL_EVM_TESTNET_BROADCAST | **NO-GO** | MPC Sepolia address unfunded (0 ETH / 0 USDC) — no mock substitute |
| TOKEN_TRANSFER_VERIFIED | **PASS (Anvil only)** | Mined receipt + Transfer log + balance deltas on real node |
| INTENTS_SETTLEMENT_VERIFIED | **NO-GO** | Token transfer ≠ Intents swap; no funded testnet Intents route in-session |
| INDEPENDENT_RECONCILIATION | **PASS (Anvil)** | Node receipt + balances; synthetic/simulator receipts fail-closed |
| UNATTENDED_AGENT_EXECUTION | **PASS (shadow + live LLM)** | OpenRouter keeper NO_TRADE; pause/revoke/restart fixtures |
| MAINNET_READY_FOR_OWNER_REVIEW | **NO-GO** | Missing authentic MPC→EVM testnet broadcast + Intents settlement |

## J15 correction (P0)

`createLocalForkRpc()` is an **IN_MEMORY_RPC_SIMULATOR**, not Anvil/Hardhat. Historic J15 files preserved; corrected classifications in `J15_EVIDENCE_CORRECTION.json`. Synthetic receipts do **not** count as independent settlement.

## Blockers before owner mainnet review can flip GO

1. Fund disposable MPC-derived EVM testnet address (gas + test ERC-20) under separate testnet approval — then re-run authentic MPC→broadcast→settle.
2. Prove Intents settlement on a supported testnet route (or document permanent NO-GO if unsupported) separately from raw ERC-20 transfer.
3. Keep mainnet policy paused until explicit owner approvals for WASM upgrade / activate / unpause / funding.

## Owner approval boundary

Stop here. Any mainnet mutation requires a separate, explicit owner approval package.
