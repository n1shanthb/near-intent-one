/**
 * Gate J — shared types / reason codes (no LLM).
 */

export const FIT_OUTCOMES = Object.freeze(["ALLOWED", "ADAPTED", "REJECTED"]);
export const CRITIC_VERDICTS = Object.freeze(["APPROVE", "REJECT", "ABSTAIN"]);
export const FINAL_DECISIONS = Object.freeze([
  "EXECUTE_DRY_RUN",
  "EXECUTE",
  "NO_TRADE",
  "BLOCKED",
]);

/** Deterministic reason codes for fitter / enforcement. */
export const REASON = Object.freeze({
  ALREADY_WITHIN_MANDATE: "ALREADY_WITHIN_MANDATE",
  SIZE_REDUCED_TO_LIMIT: "SIZE_REDUCED_TO_LIMIT",
  SLIPPAGE_CLAMPED: "SLIPPAGE_CLAMPED",
  QUOTE_SELECTED: "QUOTE_SELECTED",
  ROUTE_SELECTED: "ROUTE_SELECTED",
  MANDATE_REVOKED: "MANDATE_REVOKED",
  POLICY_PAUSED: "POLICY_PAUSED",
  UNAUTHORIZED_ASSET: "UNAUTHORIZED_ASSET",
  UNSUPPORTED_NETWORK: "UNSUPPORTED_NETWORK",
  INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
  PER_TRADE_LIMIT: "PER_TRADE_LIMIT",
  DAILY_LIMIT_EXHAUSTED: "DAILY_LIMIT_EXHAUSTED",
  PENDING_EXPOSURE: "PENDING_EXPOSURE",
  MIN_VIABLE_NOT_MET: "MIN_VIABLE_NOT_MET",
  THESIS_INVALIDATED: "THESIS_INVALIDATED",
  ECONOMIC_NOT_VIABLE: "ECONOMIC_NOT_VIABLE",
  EXPIRED_QUOTE: "EXPIRED_QUOTE",
  STALE_MARKET_DATA: "STALE_MARKET_DATA",
  MALFORMED_PROPOSAL: "MALFORMED_PROPOSAL",
  LLM_TIMEOUT: "LLM_TIMEOUT",
  CRITIC_VETO: "CRITIC_VETO",
  CRITIC_ABSTAIN: "CRITIC_ABSTAIN",
  LIMIT_EVASION_ATTEMPT: "LIMIT_EVASION_ATTEMPT",
  FEASIBLE_SET_EMPTY: "FEASIBLE_SET_EMPTY",
  STRATEGIST_NO_TRADE: "STRATEGIST_NO_TRADE",
  FITTER_REJECTED: "FITTER_REJECTED",
  BALANCE_UNVERIFIED: "BALANCE_UNVERIFIED",
  BALANCE_DISCREPANCY: "BALANCE_DISCREPANCY",
  REPLAY_PROTECTED: "REPLAY_PROTECTED",
  ENFORCEMENT_FAIL: "ENFORCEMENT_FAIL",
});

export const USDC_DECIMALS = 6;

export function usdcRawFromUsd(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n) || n < 0) throw new Error(`bad_usd:${usd}`);
  return BigInt(Math.round(n * 10 ** USDC_DECIMALS)).toString();
}

export function usdFromUsdcRaw(raw) {
  const v = BigInt(raw);
  const scale = 10n ** BigInt(USDC_DECIMALS);
  const whole = v / scale;
  const frac = v % scale;
  return Number(whole) + Number(frac) / Number(scale);
}

export function nowIso() {
  return new Date().toISOString();
}

export function stableOpId(prefix, parts) {
  const body = parts.map((p) => String(p ?? "")).join("|");
  let h = 2166136261;
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${prefix}-${(h >>> 0).toString(16)}`;
}
