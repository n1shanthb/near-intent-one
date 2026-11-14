# NIO Commerce — NEAR Agent Market readiness

**At:** 2026-11-14T16:57:39.311Z  
**Payments:** OFF · **Mock labeled as paid:** none

## Acceptance

| Gate | Result |
|------|--------|
| LIVE_MARKETPLACE_DISCOVERY | **PASS** |
| REAL_AGENT_PRICING | **PASS** |
| COMMERCE_FITTER | **PASS** |
| MARKETPLACE_ACCOUNT_READY | **FAIL** |
| COMMERCE_BUDGET_ENFORCED | **PASS** |
| FIRST_PURCHASE_READY | **BLOCKED** |
| FIRST_PURCHASE_PAID | **FAIL** |
| DELIVERABLE_VERIFIED | **FAIL** |
| OCI_COMMERCE_ACTIVITY | **PASS** |
| FRONTEND_COMMERCE_VISIBLE | **BLOCKED** |

## Proposed first hire (STOP before funding)

- **Agent:** On-Chain & Market Data Research (`llmrt-onchain-research`)
- **URL:** https://market.near.ai/agents/llmrt-onchain-research
- **Price:** 0.15 USDC (rail: marketplace_escrow_USDC)
- **Max cost:** 0.15 USDC
- **Available now:** true
- **Task brief:** Produce a short independent research brief (≤400 words) on current NEAR Intents / 1Click cross-chain USDC routing risks for a paused autonomous trading agent. Cite public sources only. Do not request keys, signatures, or mandate changes. Label estimates clearly. Output Markdown.
- **Brief hash:** `003e96bc85e246be8b5543a4a054fd4f77b86feeac975cd5666f3ee2f81ad9ef`
- **Account:** (not configured — need buyer OAuth token)
- **Delivery:** Markdown research brief via marketplace job deliverable
- **Acceptance window:** 3 days
- **Refund:** Buyer accept/reject per market.near.ai Standardized Job Terms; escrow releases on accept
- **STOP before:** funding, hire_confirmation, payment


## Next authorization required

1. Create marketplace buyer account and fund USDC escrow balance ≥ quoted price.  
2. Provide server-side `NIO_COMMERCE_BUYER_TOKEN` (never Vercel/Vite).  
3. Explicit operator approval to set `NIO_COMMERCE_PAYMENTS_ENABLED=1` for **exactly one** hire.  
4. Complete approval URL / escrow fund on market.near.ai.  
5. Verify delivery hash + receipt; only then mark FIRST_PURCHASE_PAID.

Evidence JSON: `COMMERCE_MARKET_READINESS.json`
