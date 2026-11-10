/** Gate K — Sepolia testnet AI-directed trading constants. */

export const GATE = "K";
export const NETWORK = "testnet";
export const CHAIN_ID = 11155111;
export const USDC_SEPOLIA = "0x2e6AD9E6D59bB4585ea0E6762c3b637dde29DAD2";
export const ORIGIN_ASSET =
  "nep141:eth-0x2e6ad9e6d59bb4585ea0e6762c3b637dde29dad2.tp-omft.testnet";
export const DEST_ASSET = "nep141:wnear.tidepool-sandbox.testnet";
export const DEMO_PREFIX = "nio-c-";

/** First live AI test overlay — on top of on-chain mandate, never instead. */
export const FIRST_TEST = Object.freeze({
  portfolio_id: "i-a-a4e7",
  max_trade_usdc_raw: "1000000", // 1 USDC
  max_trades: 1,
  pair: { origin: "USDC", destination: "wNEAR" },
  networks: ["sepolia", "sepolia+intents", "near-intents"],
});

export const DEFAULT_EDGE_BUFFER_BPS = Number(
  process.env.GATE_K_EDGE_BUFFER_BPS || 20
);
export const DEFAULT_MAX_GAS_PRICE = 5_000_000_000n;
export const DEFAULT_GAS_LIMIT = 250000n;

export const MODE = Object.freeze({
  DRY_RUN: "AI_DRY_RUN",
  TESTNET_EXECUTION: "AI_TESTNET_EXECUTION",
  AUTONOMOUS: "AI_AUTONOMOUS",
});

export const REASON = Object.freeze({
  AUTONOMOUS_DISABLED: "AUTONOMOUS_DISABLED",
  OPERATOR_CONFIRM_REQUIRED: "OPERATOR_CONFIRM_REQUIRED",
  EXECUTION_DISABLED: "EXECUTION_DISABLED",
  SAFETY_LIMIT: "SAFETY_LIMIT",
  SINGLE_FLIGHT: "SINGLE_FLIGHT",
  MAX_TRADES: "MAX_TRADES",
  NO_FRESH_QUOTE: "NO_FRESH_QUOTE",
  EDGE_BUFFER: "EDGE_BUFFER",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  WRONG_PORTFOLIO: "WRONG_PORTFOLIO",
  RECONCILER_DOWN: "RECONCILER_DOWN",
  POLICY_CHANGED: "POLICY_CHANGED",
  INFLIGHT_SIGNATURE: "INFLIGHT_SIGNATURE",
});
