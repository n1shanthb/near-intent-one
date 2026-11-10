# Gate I — Portfolio A Sepolia funding plan

**Status:** Approved by user ("u can fund new addresses"). Demo `nio-c-*` / `0xcbf7bb…` residual **not** used.

## Target portfolio A

| Field | Value |
|-------|-------|
| Portfolio id | `i-a-a4e7` |
| Policy | `policy.nio-i-a4e7-a-owner.testnet` |
| Owner | `nio-i-a4e7-a-owner.testnet` |
| MPC / Intents EVM | `0x30af279bedef3bb82c7f47bb9f6a514f6264e752` |
| Path | `trading/v1/portfolio/i-a-a4e7` |
| USDC (Sepolia) | `0x2e6AD9E6D59bB4585ea0E6762c3b637dde29DAD2` |

## Assets & amounts (minimal)

| Asset | Amount | Purpose |
|-------|--------|---------|
| Sepolia ETH | **0.02 ETH** (~gas for faucet claim + 1 withdraw + 1–2 trades) | Gas only |
| Sepolia USDC | **10 USDC** via open `faucet()` on Tidepool USDC (selector `0xde5f72fd`) once ETH present | Trade 1 USDC + withdraw dust + residual |

Gas assumptions: ~1 gwei floor, ERC-20 transfer ≤100k gas, faucet claim ≤250k gas.

## Software funder (preferred)

| Role | Address |
|------|---------|
| Funder (send ETH here) | `0x1b1efa11e65c290a8cff0d0c22be3d3e506a5fc4` |
| Withdraw recipient | `0x9950ce47498ab3a83b278879aa9f0e477346ac39` |
| Portfolio A MPC | `0x30af279bedef3bb82c7f47bb9f6a514f6264e752` |

Key material: `.gate-i-data/sepolia-funder.json` (gitignored).

Public Alchemy/Google faucets **reject** fresh MPC addresses (need ≥0.001 mainnet ETH). PoW faucet needs captcha. Therefore fund the **software funder** from any Sepolia wallet you control (MetaMask), then run `node scripts/gate-i-closure.mjs`.

## Live status (2026-11-09)

| Step | Status | Evidence |
|------|--------|----------|
| MetaMask → funder 0.05 ETH | **PASS** | `0x172375a91a49a9632657b1d097b7ad8a7a20f21670f4b53c90aabe44721682bb` |
| Funder → A USDC (50) | **PASS** | `0xcda99eac…` (ethers + `estimateGas`) |
| Funder → A ETH | **FAIL** | Plain ETH transfers from funder succeed only to MetaMask `0x42645ce4…`; sends to A / fresh EOAs land `status=0` `gasUsed=21000` (RPC-consistent). |
| A ETH for gas | **PASS** | Faucet `0xe1790149aff92e30a3a55c4464720f45452c5e5a7cc8119da7729b7162c69a02` → A **0.05 ETH** (status `0x1`) |
| Closure B1–B3 | **PASS** | See `GATE_I.md` / `evidence/live/gate-i-closure.json` |

## Sequence

1. Send **≥0.02 Sepolia ETH** → funder `0x1b1efa11…5fc4` **and/or directly to A** (direct to A required for gas given funder ETH quirk).
2. Funder claims Tidepool USDC `faucet()` and transfers USDC → A (ETH→A from funder is unreliable — use MetaMask).
3. Owner allowlists withdraw recipient.
4. **Withdraw proof:** while trading paused, `owner_request_withdraw_signature` → broadcast ERC-20 → Sepolia receipt (not merely NEAR `withdraw_signed`).
5. Owner **unpause**; set trusted attestor; agent TRADE 1 USDC → Tidepool settle → reconciler.
6. Confirm portfolio B cannot call owner/admin methods on A.

## Risks

| Risk | Mitigation |
|------|------------|
| Faucets require mainnet ETH / captcha | Prefer funder key; do not touch demo MPC |
| Spending demo residual | **Forbidden** without Ledger + explicit unrevoke |
| Over-trading | Cap trade at 1 USDC (`1000000` base units) |
| Agent withdraw | Contract rejects; isolation tests re-run |

## Acceptance

- Deposit: live Sepolia USDC > 0 on A’s MPC address with funding tx hash.
- Withdraw: Sepolia tx hash + `status=0x1` + before/after balances; destination ≠ agent.
- Trade: decision → MPC sign → Sepolia broadcast → Tidepool SUCCESS → reconcile on A only.
