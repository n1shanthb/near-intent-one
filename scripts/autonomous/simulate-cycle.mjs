#!/usr/bin/env node
/**
 * Shadow autonomous cycle — no mainnet mutations.
 */
import { simulateCycle } from "../../packages/autonomous/simulateCycle.mjs";

const mandate_input = {
  network: "mainnet",
  policy_contract: "policy.nishanthb.near",
  owner: "nishanthb.near",
  portfolio_id: "nio-mainnet-v1",
  agent_id: "agent.nishanthb.near",
  executor_id: "agent.nishanthb.near",
  mandate_id: "shadow-sim-1",
  epoch: 2,
  strategy_hash: "sha256:shadow",
  prompt_version_hash: "sha256:prompt-v1",
  allowed_chains: ["near", "eip155:1", "eip155:8453", "eip155:42161"],
  allowed_assets: [
    "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  ],
  allowed_venues: ["near_intents_1click"],
  allowed_destinations: ["nishanthb.near"],
  trading_enabled: true,
  max_trade_raw: "1000000",
  total_trading_budget_raw: "5000000",
  daily_turnover_budget_raw: "5000000",
  max_pending_exposure_raw: "2000000",
  max_slippage_bps: 100,
  max_gas_budget: "2500000000000000",
  data_purchase_enabled: true,
  commerce_budget_raw: "500000",
  max_marketplace_purchase_raw: "100000",
  max_purchases_per_period: 3,
  marketplace_allowlist: ["near_agent_market_mock"],
  provider_allowlist: ["mock_research_provider"],
  openrouter_daily_usd_micros: "2000000",
  openrouter_max_requests_per_day: 50,
};

const market = {
  pair: { origin: "USDC", destination: "NEAR" },
  freshness_ms: 1_000,
  prices: { usdc_usd: 1, near_usd: 5 },
};

const r = await simulateCycle({
  mandate_input,
  market,
  portfolio_id: "nio-mainnet-v1",
});
console.log(JSON.stringify(r, null, 2));
if (!r.ok) process.exitCode = 1;
