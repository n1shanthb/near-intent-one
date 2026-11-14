# NIO Commerce — marketplace account readiness

**At:** 2026-11-14T17:21:20.379Z  
**Paid:** no · **Payments enabled:** no

## Probe results

| Check | Result |
|-------|--------|
| LIVE_MARKETPLACE_DISCOVERY | **PASS** |
| HIRE_DRAFT_PROBE | **PASS** |
| MARKETPLACE_ACCOUNT_READY | **FAIL** |
| BUYER_TOKEN_PRESENT | **FAIL** |
| WALLET_READABLE | **FAIL** |
| COMMERCE_PAYMENTS_STILL_OFF | **PASS** |
| FIRST_PURCHASE_PAID | **FAIL** |

## Hire-draft (unauthenticated)

- Created: yes
- Draft id: `22947c2a-b19b-4c0d-9a31-71b384b392b4`
- Agent: llmrt-onchain-research
- Discarded: yes
- Funded: **no**

## Buyer auth (required before first purchase)

Official path: human OAuth via [MCP buyer skill](https://market.near.ai/skill/mcp-buyer/SKILL.md) or web session at https://market.near.ai  

**Do not** use `aat_` agent tokens — they cannot hire.

1. Sign in as a human on market.near.ai  
2. Fund USDC balance ≥ **0.15** (proposed hire)  
3. Connect MCP as **yourself** (or place a server-side human session token in `NIO_COMMERCE_BUYER_TOKEN`)  
4. Re-run: `node scripts/commerce/account-readiness.mjs`  
5. Only after that + explicit approval: `NIO_COMMERCE_PAYMENTS_ENABLED=1` for **one** job  

Evidence: `COMMERCE_ACCOUNT_READINESS.json`
