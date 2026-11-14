/**
 * Autonomous Mandate V1 Schema
 * CANONICAL representation with integer base units (raw strings).
 * Enforcement classification: ON_CHAIN_ENFORCED, PLANNED, OFF_CHAIN_ONLY.
 * 
 * NO mainnet mutations in this module. Schema/validation only.
 */

import { strict as assert } from "node:assert";

export const MANDATE_V1_KIND = "nio_autonomous_mandate_v1";

export const ENFORCEMENT = Object.freeze({
  ON_CHAIN: "ON_CHAIN_ENFORCED",
  PLANNED: "PLANNED",
  OFF_CHAIN: "OFF_CHAIN_ONLY",
});

/**
 * Build a draft Mandate V1 from input.
 * Rejects floats. All money fields MUST be integer raw digit strings.
 * 
 * @param {object} input
 * @returns {object} mandate draft (not yet validated)
 */
export function buildMandateV1Draft(input) {
  assert(typeof input === "object" && input !== null, "input_required");

  // Validate no floats in money fields
  const moneyFields = [
    "max_trade_raw",
    "total_trading_budget_raw",
    "daily_turnover_budget_raw",
    "max_pending_exposure_raw",
    "max_gas_budget",
    "commerce_budget_raw",
    "max_marketplace_purchase_raw",
    "openrouter_daily_usd_micros",
  ];

  for (const field of moneyFields) {
    const val = input[field];
    if (val !== undefined && val !== null) {
      const str = String(val);
      if (/[.]/.test(str)) {
        throw new Error(`${field}_cannot_be_float`);
      }
      if (!/^\d+$/.test(str)) {
        throw new Error(`${field}_must_be_digit_string`);
      }
    }
  }

  const now = Date.now();
  const created_at_ms = input.created_at_ms ?? now;
  const expires_at_ms = input.expires_at_ms ?? now + 30 * 86400 * 1000; // 30 days default

  return {
    kind: MANDATE_V1_KIND,
    network: String(input.network || "mainnet"),
    policy_contract: String(input.policy_contract || ""),
    owner: String(input.owner || ""),
    portfolio_id: String(input.portfolio_id || ""),
    agent_id: String(input.agent_id || ""),
    executor_id: String(input.executor_id || ""),
    mandate_id: String(input.mandate_id || ""),
    epoch: Number(input.epoch ?? 0),
    strategy_hash: String(input.strategy_hash || ""),
    prompt_version_hash: String(input.prompt_version_hash || ""),
    created_at_ms: Number(created_at_ms),
    expires_at_ms: Number(expires_at_ms),

    // Trading limits
    allowed_chains: Array.isArray(input.allowed_chains) ? input.allowed_chains : [],
    allowed_assets: Array.isArray(input.allowed_assets) ? input.allowed_assets : [],
    allowed_venues: Array.isArray(input.allowed_venues) ? input.allowed_venues : [],
    allowed_destinations: Array.isArray(input.allowed_destinations)
      ? input.allowed_destinations
      : [],

    trading_enabled: Boolean(input.trading_enabled ?? false),
    max_trade_raw: String(input.max_trade_raw || "0"),
    total_trading_budget_raw: String(input.total_trading_budget_raw || "0"),
    daily_turnover_budget_raw: String(input.daily_turnover_budget_raw || "0"),
    max_pending_exposure_raw: String(input.max_pending_exposure_raw || "0"),
    max_slippage_bps: Number(input.max_slippage_bps ?? 0),
    max_gas_budget: String(input.max_gas_budget || "0"),
    min_trade_interval_sec: Number(input.min_trade_interval_sec ?? 0),
    max_trades_per_period: Number(input.max_trades_per_period ?? 0),

    // Commerce limits
    data_purchase_enabled: Boolean(input.data_purchase_enabled ?? false),
    commerce_budget_raw: String(input.commerce_budget_raw || "0"),
    max_marketplace_purchase_raw: String(input.max_marketplace_purchase_raw || "0"),
    max_purchases_per_period: Number(input.max_purchases_per_period ?? 0),
    marketplace_allowlist: Array.isArray(input.marketplace_allowlist)
      ? input.marketplace_allowlist
      : [],
    provider_allowlist: Array.isArray(input.provider_allowlist)
      ? input.provider_allowlist
      : [],

    // AI spend limits
    openrouter_daily_usd_micros: String(input.openrouter_daily_usd_micros || "0"),
    openrouter_max_requests_per_day: Number(input.openrouter_max_requests_per_day ?? 0),

    // Control semantics
    pause_semantics: String(input.pause_semantics || "owner_can_pause"),
    revoke_semantics: String(input.revoke_semantics || "owner_can_revoke_anytime"),

    // Capability scopes
    capability_scopes: Array.isArray(input.capability_scopes)
      ? input.capability_scopes
      : ["TRADE", "RESEARCH", "BUY_DATA"],

    // Funding boundaries
    funding_boundaries: input.funding_boundaries || {
      allow_self_fund: false,
      max_deposit_per_tx: "0",
      require_owner_approval: true,
    },

    // Enforcement map (per-field classification)
    enforcement_map: buildEnforcementMap(input),
  };
}

/**
 * Build enforcement classification for each mandate field.
 * Honest marking based on current contract capabilities.
 */
function buildEnforcementMap(input) {
  const map = {
    // Trading limits that map to PolicyLimits
    max_trade_raw: ENFORCEMENT.ON_CHAIN,
    total_trading_budget_raw: ENFORCEMENT.ON_CHAIN,
    daily_turnover_budget_raw: ENFORCEMENT.ON_CHAIN,
    max_pending_exposure_raw: ENFORCEMENT.ON_CHAIN,
    max_slippage_bps: ENFORCEMENT.ON_CHAIN,
    max_gas_budget: ENFORCEMENT.ON_CHAIN,
    allowed_chains: ENFORCEMENT.ON_CHAIN,
    allowed_assets: ENFORCEMENT.ON_CHAIN,
    allowed_venues: ENFORCEMENT.ON_CHAIN,
    allowed_destinations: ENFORCEMENT.ON_CHAIN,

    // Trading enablement
    trading_enabled: input.enforce_autonomous_on_agent
      ? ENFORCEMENT.PLANNED
      : ENFORCEMENT.OFF_CHAIN,

    // Rate limits (not in current contract)
    min_trade_interval_sec: ENFORCEMENT.PLANNED,
    max_trades_per_period: ENFORCEMENT.PLANNED,

    // Commerce (off-chain only or planned)
    data_purchase_enabled: ENFORCEMENT.OFF_CHAIN,
    commerce_budget_raw: ENFORCEMENT.OFF_CHAIN,
    max_marketplace_purchase_raw: ENFORCEMENT.OFF_CHAIN,
    max_purchases_per_period: ENFORCEMENT.PLANNED,
    marketplace_allowlist: ENFORCEMENT.OFF_CHAIN,
    provider_allowlist: ENFORCEMENT.OFF_CHAIN,

    // AI spend (off-chain only)
    openrouter_daily_usd_micros: ENFORCEMENT.OFF_CHAIN,
    openrouter_max_requests_per_day: ENFORCEMENT.OFF_CHAIN,

    // Control semantics (off-chain interpretation)
    pause_semantics: ENFORCEMENT.OFF_CHAIN,
    revoke_semantics: ENFORCEMENT.OFF_CHAIN,

    // Capabilities (off-chain)
    capability_scopes: ENFORCEMENT.OFF_CHAIN,

    // Funding (off-chain)
    funding_boundaries: ENFORCEMENT.OFF_CHAIN,
  };

  return map;
}

/**
 * Validate a Mandate V1 object.
 * 
 * @param {object} mandate
 * @returns {{ ok: true } | { ok: false, reasons: string[] }}
 */
export function validateMandateV1(mandate) {
  const reasons = [];

  if (mandate.kind !== MANDATE_V1_KIND) {
    reasons.push("invalid_kind");
  }

  // Required fields
  const requiredStrings = [
    "network",
    "policy_contract",
    "owner",
    "portfolio_id",
    "agent_id",
    "executor_id",
    "mandate_id",
  ];

  for (const field of requiredStrings) {
    if (!mandate[field] || typeof mandate[field] !== "string") {
      reasons.push(`${field}_required`);
    }
  }

  // Epoch must be non-negative
  if (typeof mandate.epoch !== "number" || mandate.epoch < 0) {
    reasons.push("invalid_epoch");
  }

  // Timestamps
  if (typeof mandate.created_at_ms !== "number" || mandate.created_at_ms <= 0) {
    reasons.push("invalid_created_at_ms");
  }

  if (typeof mandate.expires_at_ms !== "number" || mandate.expires_at_ms <= 0) {
    reasons.push("invalid_expires_at_ms");
  }

  if (mandate.expires_at_ms <= mandate.created_at_ms) {
    reasons.push("expires_before_created");
  }

  // Check for expired
  if (Date.now() > mandate.expires_at_ms) {
    reasons.push("mandate_expired");
  }

  // Arrays
  if (!Array.isArray(mandate.allowed_chains) || !mandate.allowed_chains.length) {
    reasons.push("allowed_chains_required");
  }

  if (!Array.isArray(mandate.allowed_assets) || !mandate.allowed_assets.length) {
    reasons.push("allowed_assets_required");
  }

  if (!Array.isArray(mandate.allowed_venues)) {
    reasons.push("allowed_venues_must_be_array");
  }

  if (!Array.isArray(mandate.capability_scopes)) {
    reasons.push("capability_scopes_must_be_array");
  }

  // Money fields must be digit strings
  const moneyFields = [
    "max_trade_raw",
    "total_trading_budget_raw",
    "daily_turnover_budget_raw",
    "max_pending_exposure_raw",
    "max_gas_budget",
    "commerce_budget_raw",
    "max_marketplace_purchase_raw",
    "openrouter_daily_usd_micros",
  ];

  for (const field of moneyFields) {
    const val = mandate[field];
    if (val !== undefined && val !== null) {
      const str = String(val);
      if (!/^\d+$/.test(str)) {
        reasons.push(`${field}_invalid_format`);
      }
      if (/[.]/.test(str)) {
        reasons.push(`${field}_cannot_be_float`);
      }
    }
  }

  // Enforcement map
  if (typeof mandate.enforcement_map !== "object" || !mandate.enforcement_map) {
    reasons.push("enforcement_map_required");
  }

  return reasons.length ? { ok: false, reasons } : { ok: true };
}

/**
 * Check if a mandate is expired.
 */
export function isMandateExpired(mandate) {
  return Date.now() > mandate.expires_at_ms;
}

/**
 * Check if a mandate is fresh (epoch-based replay protection).
 */
export function isMandateFresh(mandate, currentEpoch) {
  return mandate.epoch >= currentEpoch;
}
