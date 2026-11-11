# Testnet funded multichain trade evidence

**Network:** Tidepool community testnet + Ethereum Sepolia (NOT production 1Click / NOT mainnet)  
**Acceptance override:** **false**  
**Re-sign on retry:** **false**

## P0 — Prior SUCCESS was CUSTODY FAILURE

Trade `0x8bf6d1d8…422a` / NEAR `BtguMNje…bvNk` delivered wNEAR to uncreateable account id `0x30af279bedef3bb82c7f47bb9f6a514f6264e752` via `DESTINATION_CHAIN` + EVM recipient.

Full investigation: [`TESTNET_DESTINATION_CUSTODY_P0.md`](./TESTNET_DESTINATION_CUSTODY_P0.md)  
**Verdict: CUSTODY FAILURE. Recovered funds: none** (`OnlyImplicitAccountCreationAllowed`).  
**Do not repeat** that destination configuration.

## P1 — Recoverable custody trade (this run)

| Field | Value |
|-------|-------|
| Objective | Owner-authorized testnet inventory rebalance |
| Decision source | Deterministic rebalance critic (not LLM Critic PASS) — see `AI_VS_DETERMINISTIC_ACCEPTANCE.md` |
| Fitter | **ALLOWED** |
| Critic | **APPROVE** (`deterministic_rebalance_critic`) |
| Amount | `1000000` raw (1.0 USDC) |
| recipient | **`nio-i-a4e7-a-owner.testnet`** |
| recipientType | `DESTINATION_CHAIN` |
| refundTo | `0x30af279bedef3bb82c7f47bb9f6a514f6264e752` |
| destinationAsset | `nep141:wnear.tidepool-sandbox.testnet` |
| Sepolia tx | [`0xc6a3d13b368627d13d2103cc0005846076fa50003a3ea6d48b6a5405cf8de8e4`](https://sepolia.etherscan.io/tx/0xc6a3d13b368627d13d2103cc0005846076fa50003a3ea6d48b6a5405cf8de8e4) |
| NEAR propose | `C4chr1wwrTtZ5P7uUg1yzdnzJV2Wo4H1hCYM3G3bam2d` |
| NEAR sign | `C3eRYNpEKsAQYVRcABGvM3XT7artTpbzgb8NcFpPtzz9` |
| Tidepool | **SUCCESS** |
| `ft_balance_of(owner)` after | `263260765079365092512000` |
| Custody verdict | **CUSTODY_VERIFIED_RECOVERABLE** |

### Withdrawal control proof

| Field | Value |
|-------|-------|
| storage_deposit(policy) | `Ewaz7gn8oLM8tVX5ksyYUk98ooWMoWrhWCAbnBMDhx8m` |
| ft_transfer owner→policy (0.001 wNEAR) | `5cf6y1q7ZK4X5eGTmfb6LYcBYgaqSkmZK3PGYKBC6zEG` |
| Evidence | `TESTNET_DESTINATION_WITHDRAWAL_PROOF.json` |

## Counts

- Prior misdelivered trade: **1** (CUSTODY FAILURE — funds stuck)
- Recoverable owner-NEAR trade: **1** (verified)
- Second source chain: **not executed** (Arb/Base Sepolia USDC = 0)

## Refunds

**UNVERIFIED** (no intentional lossy refund induced). Owner-controlled `refundTo` is EVM MPC on origin.
