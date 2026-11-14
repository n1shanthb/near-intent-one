# Commerce purchase authorization

**Operator:** authorized one hire ≤ 0.15 USDC

## Approved hire
- Agent: `llmrt-onchain-research`
- URL: https://market.near.ai/agents/llmrt-onchain-research
- Max: **0.15 USDC** · 1 job

## Execution status
**NOT PAID** — missing human marketplace buyer session.

NIO still needs:
1. Sign in at https://market.near.ai as yourself  
2. Fund ≥ 0.15 USDC marketplace balance  
3. Provide server-side `NIO_COMMERCE_BUYER_TOKEN` (human OAuth/MCP token — not `aat_`, not Ledger/MPC/ops keys)  
4. Then say **run hire** so the one-shot paid script can execute  

Payments stay off until that credentialed run.
