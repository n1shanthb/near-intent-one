/**
 * Gate J — reproducible fixtures (same strategy thesis across A/B/C).
 */
import { usdcRawFromUsd } from "./types.mjs";

export const THESIS_ID = "usdc-to-wnear-mandate-fit-v1";
export const THESIS =
  "Rotate a modest USDC float into wNEAR on testnet intents while edge covers fees and slippage.";

/** Shared strategy body — sizes differ per scenario. */
export function baseStrategistProposal({
  proposed_size_usd,
  min_viable_size_usd,
  // Edge must clear fee + impact + slippage in the deterministic viability model.
  edge_bps = 90,
  fee_bps = 5,
  price_impact_bps = 8,
  max_slippage_bps = 50,
} = {}) {
  return {
    choice: "TRADE",
    pair: { origin: "USDC", destination: "wNEAR" },
    direction: "SELL_ORIGIN",
    proposed_size_usd,
    min_viable_size_usd,
    thesis: THESIS,
    thesis_id: THESIS_ID,
    expected_benefit: {
      edge_bps,
      horizon: "intraday_testnet",
      notes: "Fixture edge — not a live PnL claim",
    },
    estimated_costs: {
      fee_bps,
      price_impact_bps,
      notes: "Fixture costs",
    },
    max_slippage_bps,
    invariants: ["pair", "direction", "thesis_id"],
    evidence: [{ source: "fixture", note: "shared thesis" }],
    uncertainty: "testnet liquidity / oracle gap",
    network: "sepolia",
  };
}

export function baseMandate({
  per_trade_limit_usd = 20,
  daily_limit_usd = 100,
  daily_spent_usd = 0,
  balance_usd = 50,
  revoked = false,
  paused = false,
  allowed_assets = ["USDC", "wNEAR"],
  allowed_networks = ["sepolia", "sepolia+intents", "near-intents"],
  max_slippage_bps = 100,
  reserved_pending_exposure = "0",
  max_pending_exposure = "100000000",
  recent_operation_sizes = [],
} = {}) {
  return {
    portfolio_id: "i-a-a4e7",
    owner_account: "nio-i-a4e7-a-owner.testnet",
    policy_contract: "policy.nio-i-a4e7-a-owner.testnet",
    policy_hash: "gate-j-fixture-v1",
    policy_version: "gate-j-fixture-v1",
    revoked,
    paused,
    allowed_assets,
    allowed_networks,
    per_trade_limit_usdc_raw: usdcRawFromUsd(per_trade_limit_usd),
    daily_limit_usdc_raw: usdcRawFromUsd(daily_limit_usd),
    daily_spent_usdc_raw: usdcRawFromUsd(daily_spent_usd),
    balance_usdc_raw: usdcRawFromUsd(balance_usd),
    reserved_pending_exposure,
    max_pending_exposure,
    max_slippage_bps,
    recent_operation_sizes,
  };
}

export function freshMarket(overrides = {}) {
  return {
    as_of: new Date().toISOString(),
    pair: { origin: "USDC", destination: "wNEAR" },
    network: "sepolia+intents",
    usdc_usd: 1,
    volatility_bps_1h: 60,
    liquidity_score: 0.8,
    sources: [{ name: "fixture", as_of: new Date().toISOString() }],
    stale: false,
    ...overrides,
  };
}

/** A. ALLOWED — propose $10, permit $20, min viable $5 */
export function scenarioAllowed() {
  return {
    id: "ALLOWED",
    mandate: baseMandate({ per_trade_limit_usd: 20 }),
    proposal: baseStrategistProposal({
      proposed_size_usd: 10,
      min_viable_size_usd: 5,
    }),
    market: freshMarket(),
    critic: "APPROVE",
  };
}

/** B. ADAPTED — propose $100, permit $20, min viable $10 */
export function scenarioAdapted() {
  return {
    id: "ADAPTED",
    mandate: baseMandate({ per_trade_limit_usd: 20 }),
    proposal: baseStrategistProposal({
      proposed_size_usd: 100,
      min_viable_size_usd: 10,
    }),
    market: freshMarket(),
    critic: "APPROVE",
  };
}

/** C. REJECTED — propose $100, permit $20, min viable $50 */
export function scenarioRejected() {
  return {
    id: "REJECTED",
    mandate: baseMandate({ per_trade_limit_usd: 20 }),
    proposal: baseStrategistProposal({
      proposed_size_usd: 100,
      min_viable_size_usd: 50,
    }),
    market: freshMarket(),
    critic: "APPROVE",
  };
}

export function scenarioUnauthorizedToken() {
  const p = baseStrategistProposal({ proposed_size_usd: 10, min_viable_size_usd: 5 });
  p.pair = { origin: "WBTC", destination: "wNEAR" };
  return {
    id: "UNAUTHORIZED_TOKEN",
    mandate: baseMandate(),
    proposal: p,
    market: freshMarket(),
    critic: "APPROVE",
  };
}

export function scenarioUnsupportedChain() {
  const p = baseStrategistProposal({ proposed_size_usd: 10, min_viable_size_usd: 5 });
  p.network = "ethereum-mainnet";
  return {
    id: "UNSUPPORTED_CHAIN",
    mandate: baseMandate(),
    proposal: p,
    market: freshMarket(),
    critic: "APPROVE",
  };
}

export function scenarioExpiredQuote() {
  const p = baseStrategistProposal({ proposed_size_usd: 10, min_viable_size_usd: 5 });
  p.selected_quote = {
    depositAddress: "0xdead",
    minAmountOut: "1",
    amountIn: usdcRawFromUsd(10),
    deadline: new Date(Date.now() - 60_000).toISOString(),
  };
  return {
    id: "EXPIRED_QUOTE",
    mandate: baseMandate(),
    proposal: p,
    market: freshMarket(),
    critic: "APPROVE",
  };
}

export function scenarioInsufficientBalance() {
  return {
    id: "INSUFFICIENT_BALANCE",
    mandate: baseMandate({ balance_usd: 3, per_trade_limit_usd: 20 }),
    proposal: baseStrategistProposal({
      proposed_size_usd: 10,
      min_viable_size_usd: 5,
    }),
    market: freshMarket(),
    critic: "APPROVE",
  };
}

export function scenarioDailyLimit() {
  return {
    id: "DAILY_LIMIT",
    mandate: baseMandate({
      daily_limit_usd: 20,
      daily_spent_usd: 20,
      per_trade_limit_usd: 20,
    }),
    proposal: baseStrategistProposal({
      proposed_size_usd: 10,
      min_viable_size_usd: 5,
    }),
    market: freshMarket(),
    critic: "APPROVE",
  };
}

export function scenarioLimitEvasion() {
  return {
    id: "LIMIT_EVASION",
    mandate: baseMandate({
      per_trade_limit_usd: 20,
      recent_operation_sizes: [usdcRawFromUsd(20), usdcRawFromUsd(20), usdcRawFromUsd(20)],
    }),
    proposal: baseStrategistProposal({
      proposed_size_usd: 100,
      min_viable_size_usd: 10,
    }),
    market: freshMarket(),
    critic: "APPROVE",
  };
}

export function scenarioStaleMarket() {
  return {
    id: "STALE_MARKET",
    mandate: baseMandate(),
    proposal: baseStrategistProposal({
      proposed_size_usd: 10,
      min_viable_size_usd: 5,
    }),
    market: freshMarket({
      stale: true,
      reason: "fixture_stale",
      as_of: new Date(Date.now() - 3600_000).toISOString(),
    }),
    critic: "APPROVE",
  };
}

export function scenarioCriticVeto() {
  return {
    id: "CRITIC_VETO",
    mandate: baseMandate(),
    proposal: baseStrategistProposal({
      proposed_size_usd: 10,
      min_viable_size_usd: 5,
    }),
    market: freshMarket(),
    critic: "REJECT",
  };
}

export function scenarioRevoked() {
  return {
    id: "REVOKED",
    mandate: baseMandate({ revoked: true }),
    proposal: baseStrategistProposal({
      proposed_size_usd: 10,
      min_viable_size_usd: 5,
    }),
    market: freshMarket(),
    critic: "APPROVE",
  };
}

export const ALL_SCENARIOS = [
  scenarioAllowed,
  scenarioAdapted,
  scenarioRejected,
  scenarioUnauthorizedToken,
  scenarioUnsupportedChain,
  scenarioExpiredQuote,
  scenarioInsufficientBalance,
  scenarioDailyLimit,
  scenarioLimitEvasion,
  scenarioStaleMarket,
  scenarioCriticVeto,
  scenarioRevoked,
];
