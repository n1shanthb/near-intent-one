# Testnet funded multichain trade evidence

**Network:** Tidepool community testnet + Ethereum Sepolia (NOT production 1Click / NOT mainnet)  
**Acceptance override:** **false**  
**Re-sign on retry:** **false** (rebroadcast of identical signed bytes)

## Why earlier AI / matrix said NO_TRADE

1. **Mainnet matrix** (`multichain-quote-matrix.mjs`) passed `balances: {}` on purpose → `no_balance_entry` (missing verified balance association), not proof of zero wallets.
2. **Live Gate K AI** (no override) returned **NO_TRADE**: Fitter `ECONOMIC_NOT_VIABLE` + Critic **REJECT** (weak pricing / no fitted terms at review time).
3. **Sepolia MPC portfolio was funded** (~24.45 USDC + gas) — see `TESTNET_BALANCE_VERIFICATION.json`.

## Portfolio addresses

| Role | Address |
|------|---------|
| Policy | `policy.nio-i-a4e7-a-owner.testnet` |
| Owner | `nio-i-a4e7-a-owner.testnet` |
| Agent | `nio-i-a4e7-agent.testnet` |
| MPC EVM | `0x30af279bedef3bb82c7f47bb9f6a514f6264e752` |

## Verified balances (pre-trade)

| Network | Status | Token | Human |
|---------|--------|-------|-------|
| NEAR testnet (policy) | VERIFIED_POSITIVE | native NEAR | ~10.99 |
| Ethereum Sepolia | VERIFIED_POSITIVE | USDC `0x2e6AD9…DAD2` | **24.45** (+ ~0.049 ETH gas) |
| Arbitrum Sepolia | VERIFIED_ZERO | USDC | 0 |
| Base Sepolia | VERIFIED_ZERO | USDC | 0 |

## AI route selection (Tidepool dry matrix)

| Route | Capital | Quote | Result |
|-------|---------|-------|--------|
| Eth Sepolia USDC → wNEAR | yes | ok | **SELECTED** |
| Arb Sepolia USDC → wNEAR | no | ok | rejected (no capital) |
| Base Sepolia USDC → wNEAR | no | ok | rejected (no capital) |

Selection used **minAmountOut**, not `amountOutUsd` (display-only).

## Executed trade (1 USDC)

| Field | Value |
|-------|-------|
| Objective | Owner-authorized testnet inventory rebalance |
| Fitter | **ALLOWED** |
| Critic | **APPROVE** (deterministic rebalance critic; LLM path had vetoed speculative thesis) |
| Amount | `1000000` raw (1.0 USDC) |
| Deposit | `0xab89c631b2381c556231d79bb28e20ece3b8cb39` |
| NEAR propose | `Fztj18qC7ieeBuS6VBAyHniJ18R4hDrgTHuQiGd4KqBu` |
| NEAR MPC sign | `785oUE4pn13eTfuepDgqeChCySrdkgpxA4FndfyEyDXA` |
| Sepolia tx | [`0x8bf6d1d8…422a`](https://sepolia.etherscan.io/tx/0x8bf6d1d8a252bf54054d140d5b8e5ae2e83e60ba85cf6f6efc8fe41dd2e2422a) |
| Receipt | `0x1` success |
| USDC after | **23450000** (24.45 → 23.45) |
| Tidepool status | **SUCCESS** |
| Intent hashes | `Hb4ZXP3rHLU7ZQbAkkisWjmcGgk1PV5t4TAg2xJwy2wx`, `4sAEFfnkoeMxp8N7h1ySiBhqpbhqNowCA2nQrKNAzVQA` |
| Destination NEAR tx | [`BtguMNjeFE59vJqqWm1RGwvodQhzs6gVjnGUcfL6bvNk`](https://testnet.nearblocks.io/txns/BtguMNjeFE59vJqqWm1RGwvodQhzs6gVjnGUcfL6bvNk) |
| Amount out (provider) | `263247070370370421104000` wNEAR units |

### Destination balance note

`mt_balance_of` on policy/owner/MPC ids returned **0** after SUCCESS. Provider reports `intentsAccount=a4f0342b…05343` and destination tx above. Treat **provider SUCCESS + explorer txs** as settlement evidence; **independent destination balance on policy NEAR account = UNVERIFIED** (recipient was EVM `DESTINATION_CHAIN` mapping, not policy NEP-141 account).

## Counts

- Completed cross-chain swaps this session: **1** (Eth Sepolia → NEAR intents via Tidepool)
- Second source chain: **not executed** (Arb/Base Sepolia USDC/gas = 0; MPC chain-id binding not funded)

## Refunds

**UNVERIFIED** (no intentional lossy refund induced).
