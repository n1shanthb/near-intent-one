# Checkpoint J7A - Real MPC funding preparation

**NO transfers / NO auto-funding / NO escrow / NO unpause / NO Ledger / NO broadcast**

## 1. Verified MPC address

| Item | Value |
|------|-------|
| Derived | `0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4` |
| Identity match | **true** |
| Path | `trading/v1/portfolio/nio-mainnet-v1` |
| Signer | `v1.signer` |
| Policy | paused=true autonomous=false epoch=2 trusted=true |

## 2. Current Arbitrum balances

| Asset | Balance |
|-------|---------|
| ETH | 0 wei=0 |
| Native USDC (`0xaf88d065e77c8cc2239327c5edb3a432268e5831`) | 0 raw=0 |
| USDC.e (`0xff970a61a04b1ca14834a43f5de4533ebddb5cc8`) | 0 (must stay unused) |
| Chain ID check | {"ok":true,"chain_id":42161,"expected":42161} |
| Native USDC meta | USDC / USD Coin / decimals=6 verified=true |

## 3. Gas

| Item | Value |
|------|-------|
| eth_gasPrice | 20180000 wei (0.02018 gwei) |
| Transfer gas estimate | 63261 (eth_estimateGas_from_funded_holder) |
| L1 component gas | 265 fee_wei=5431970000 |
| Attestor max_gas_price | 100000000 |
| Attestor gas_limit | 250000 |
| Executable under bounds | **true** |
| Incompatibilities | [] |

## 4-5. Funding recommendation

| Asset | Recommended | Have | Deficit |
|-------|-------------|------|---------|
| ETH | 0.000063 ETH (63000000000000 wei) | 0 wei | 63000000000000 wei |
| Native USDC | 2 USDC (2000000) | 0 | 2000000 |

### A. ETH to MPC
- Chain: Arbitrum One (42161)
- To: `0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4`
- Amount: **0.000063 ETH**

### B. Native USDC to MPC
- Chain: Arbitrum One (42161)
- Token: `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` (NOT USDC.e)
- To: `0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4`
- Amount: **2 USDC**

## J7B checklist

- Confirm MetaMask/Rabby network = Arbitrum One, chainId 42161
- Confirm destination = 0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4 (re-derived MPC)
- Confirm USDC token contract = 0xaf88d065e77c8cc2239327c5edb3a432268e5831 (symbol USDC, decimals 6)
- Reject USDC.e 0xff970a61a04b1ca14834a43f5de4533ebddb5cc8
- Do not use NIO broadcast, agent key, attestor key, or Ledger for funding
- Keep policy paused=true; do not unpause; do not deposit to 1Click escrow yet

### Step A: Send native ETH
- [ ] Wait for receipt status == 0x1 (success)
- [ ] receipt.chainId / network == 42161
- [ ] tx.to == 0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4 OR value recipient == 0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4
- [ ] asset == native ETH (no token contract)
- [ ] post eth_getBalance(MPC) - pre >= recommended_wei (or deficit covered)

### Step B: Send native USDC ERC-20 transfer
- [ ] Wait for receipt status == 0x1
- [ ] network chainId == 42161
- [ ] receipt.to / logs address == 0xaf88d065e77c8cc2239327c5edb3a432268e5831
- [ ] Transfer topic to == 0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4
- [ ] Confirm NOT USDC.e contract
- [ ] post balanceOf(MPC) - pre >= 2000000 (or deficit covered)

**Funding is successful ONLY after both receipt checks and positive balance deltas. Never mark success from wallet UI alone.**

## Readiness

**READY_FOR_J7B_EXTERNAL_WALLET_FUNDING**

Next approved action: J7B: operator sends Arbitrum ETH then native USDC from an external wallet to the verified MPC address; verify receipts before any further step
