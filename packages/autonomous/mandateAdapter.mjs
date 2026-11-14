/**
 * Adapt Mandate V1 → Gate J authoritative mandate shape for fitter/pipeline.
 * Off-chain only. Does not grant signing rights.
 */

import { hashMandateV1 } from "../mandate/v1/compiler.mjs";

/**
 * @param {object} mandateV1
 * @param {object} [state] — spent/pending from journal replay
 * @returns {object} Gate J mandate
 */
export function mandateV1ToGateJ(mandateV1, state = {}) {
  const policy_hash = hashMandateV1(mandateV1);
  return {
    portfolio_id: String(mandateV1.portfolio_id),
    owner_account: String(mandateV1.owner),
    policy_contract: String(mandateV1.policy_contract),
    policy_hash,
    policy_version: String(mandateV1.mandate_id || policy_hash.slice(0, 16)),
    mandate_epoch: Number(mandateV1.epoch || 0),
    revoked: Boolean(state.revoked),
    paused: Boolean(state.paused),
    allowed_assets: [...(mandateV1.allowed_assets || [])],
    allowed_networks: [...(mandateV1.allowed_chains || [])],
    allowed_venues: [...(mandateV1.allowed_venues || [])],
    allowed_destinations: [...(mandateV1.allowed_destinations || [])],
    per_trade_limit_usdc_raw: String(mandateV1.max_trade_raw || "0"),
    daily_limit_usdc_raw: String(mandateV1.daily_turnover_budget_raw || "0"),
    daily_spent_usdc_raw: String(state.spent_today_raw || "0"),
    balance_usdc_raw: String(
      state.balance_usdc_raw || mandateV1.total_trading_budget_raw || "0"
    ),
    reserved_pending_exposure: String(state.pending_exposure_raw || "0"),
    max_pending_exposure: String(mandateV1.max_pending_exposure_raw || "0"),
    max_slippage_bps: Number(mandateV1.max_slippage_bps || 0),
    recent_operation_sizes: Array.isArray(state.recent_operation_sizes)
      ? state.recent_operation_sizes.map(String)
      : [],
    trading_enabled: Boolean(mandateV1.trading_enabled),
    expires_at_ms: Number(mandateV1.expires_at_ms || 0),
    openrouter_daily_usd_micros: String(mandateV1.openrouter_daily_usd_micros || "0"),
    openrouter_max_requests_per_day: Number(mandateV1.openrouter_max_requests_per_day || 0),
  };
}
