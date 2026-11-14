# J17 — Closing the last real-chain gap (funding boundary)

**Baseline:** `ed2bd79`  
**HARD STOP:** No mainnet upgrade, funding, mandate activation, unpause, MPC, broadcast, or spend. Testnet Sepolia transfers also require **separate explicit funding authorization** — this document is not that authorization.

## Read-only verification (live)

| Item | Result |
|------|--------|
| MPC address | `0x9a82c26b3d158cf4b657ab2a3ef9e5e6c2934d55` |
| Live derive match | **true** (`trading/v1/portfolio/j16-mpc-6890` / `j16f6890.testnet`) |
| Chain ID | `11155111` (Sepolia) |
| ETH balance | `0` |
| Nonce | `0` |
| Tidepool USDC `0x2e6AD9…` | name=`Tidepool Testnet USDC (no value)`, balance=`0` |
| Circle USDC `0x1c7D4B…` | official Circle Sepolia USDC, balance=`0` (not J16 pin) |
| Prior MPC sig | [NEAR tx](https://testnet.nearblocks.io/txns/9eaSHcVf1vCDHp9tntxFx4LvVLdzp7zxNfUs4uG362X) PASS (J16) |

## Exact TESTNET funding plan

1. **Gas:** ≥ `0.05` Sepolia ETH to MPC address (min confirm `0.01`).  
   Faucets: Alchemy / Google Cloud / Infura Sepolia — claim to owner wallet if faucet requires mainnet activity, then transfer **Sepolia ETH only** to MPC.
2. **Token (preferred):** ≥ `2.0` Tidepool Testnet USDC (`0x2e6AD9E6D59bB4585ea0E6762c3b637dde29DAD2`) — matches J16/Gate-K pin. **Not** Circle faucet inventory.
3. **Alternate:** Circle Sepolia USDC via https://faucet.circle.com — requires separate mandate allowlist update.
4. **Never:** mainnet ETH/USDC or any mainnet asset.
5. After balances confirm: set `J17_SEPOLIA_FUNDING_AUTHORIZED=1` and run `npm run j17:mpc-broadcast` (fresh nonce/fees/digest; no obsolete signature reuse).

## Gate matrix

| Gate | Verdict |
|------|---------|
| SEPOLIA_FUNDING_CONFIRMED | WAITING_OWNER_FUNDING_AUTH |
| AUTHENTIC_MPC_TO_EVM_BROADCAST | BLOCKED_AT_FUNDING_BOUNDARY |
| REAL_SEPOLIA_TOKEN_SETTLEMENT | BLOCKED_AT_FUNDING_BOUNDARY |
| INDEPENDENT_RECONCILIATION | BLOCKED (Sepolia); Anvil prior PASS |
| UNATTENDED_KEEPER_READINESS | PASS_SHADOW_FROM_J16 (+ `test:j17` safety) |
| INTENTS_TESTNET | **NOT_AVAILABLE** (official; not an engineering failure) |
| MAINNET_UPGRADE_READINESS | **NO-GO** |
| MAINNET_FUNDED_AUTONOMY_READINESS | **NO-GO** |

## Evidence

- `docs/evidence/J17_SEPOLIA_FUNDING_BOUNDARY.json`
- `docs/evidence/J17_MPC_SEPOLIA_BROADCAST.json` (auth-gate stop)
- `docs/evidence/J17_FINAL_VERDICTS.json`
- Scripts: `scripts/j17/sepolia-funding-boundary.mjs`, `scripts/j17/mpc-sepolia-broadcast.mjs`
