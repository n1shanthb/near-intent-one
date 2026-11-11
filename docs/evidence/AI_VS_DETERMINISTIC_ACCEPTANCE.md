# AI vs deterministic acceptance (testnet rebalance)

## Speculative LLM path (earlier Gate K / matrix)

| Stage | Result |
|-------|--------|
| Fitter | `ECONOMIC_NOT_VIABLE` |
| Critic | `REJECT` (LLM) |
| Outcome | **NO_TRADE** |

This path evaluated a speculative investment thesis and correctly refused when economics / critic gates failed.

## Executed funded rebalance path

| Stage | Result |
|-------|--------|
| Decision source | **Deterministic rebalance critic** (`mode: deterministic_rebalance_critic`) |
| Objective | `PORTFOLIO_REBALANCE_TESTNET` — owner-authorized faucet inventory rebalance |
| Policy | On-chain mandate (epoch hydrated); Gate K safety; no `acceptance_override` |
| Fitter | `ALLOWED` |
| Critic | `APPROVE` (deterministic — **not** LLM Critic PASS) |
| Economic rationale | Diversification / cross-chain settlement proof under explicit testnet authorization; **not** `amountOutUsd` profitability |

### What this does **not** prove

- It does **not** prove the LLM Critic selected a profitable investment.
- Changing the objective after an LLM veto solely to force execution would be illegitimate for a “real-value” claim. The rebalance objective was an **explicit owner-authorized testnet proof**, recorded as such in canary evidence.

### Future real-value trades

Keep the original objective. If LLM Critic vetoes, do not silently swap to a weaker objective to obtain APPROVE. Either rematerialize a mandate-fit thesis that survives the same critic path, or stay NO_TRADE.
