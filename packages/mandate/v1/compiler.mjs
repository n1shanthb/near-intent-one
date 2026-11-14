/**
 * Mandate V1 Compiler
 * Canonicalization, hashing, binding, and contract preview compilation.
 *
 * NO mainnet mutations. Preview/compile only.
 */

import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import { validateMandateV1, isMandateExpired, isMandateFresh, ENFORCEMENT } from "./schema.mjs";

/**
 * Canonicalize a mandate to stable JSON representation.
 * Sorted keys, no whitespace variance.
 *
 * @param {object} mandate
 * @returns {string} canonical JSON
 */
export function canonicalizeMandateV1(mandate) {
  const sorted = sortKeysDeep(mandate);
  return JSON.stringify(sorted);
}

function sortKeysDeep(obj) {
  if (Array.isArray(obj)) {
    return obj.map(sortKeysDeep);
  }
  if (obj && typeof obj === "object") {
    const sorted = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeysDeep(obj[key]);
    }
    return sorted;
  }
  return obj;
}

/**
 * Hash a mandate to sha256 hex.
 *
 * @param {object} mandate
 * @returns {string} sha256 hex
 */
export function hashMandateV1(mandate) {
  const canonical = canonicalizeMandateV1(mandate);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Bind a mandate to context (network, policy_contract, owner, agent, epoch).
 * Validates freshness, expiration, and network consistency.
 *
 * @param {object} params
 * @returns {{ ok: true, mandate_hash: string, binding: object } | { ok: false, blockers: string[] }}
 */
export function bindMandateV1({ mandate, network, policy_contract, owner, agent, epoch }) {
  const blockers = [];

  const validation = validateMandateV1(mandate);
  if (!validation.ok) {
    blockers.push(...validation.reasons);
  }

  if (mandate.network !== network) {
    blockers.push(`network_mismatch:${mandate.network}≠${network}`);
  }

  if (mandate.policy_contract !== policy_contract) {
    blockers.push(`policy_contract_mismatch:${mandate.policy_contract}≠${policy_contract}`);
  }

  if (mandate.owner !== owner) {
    blockers.push(`owner_mismatch:${mandate.owner}≠${owner}`);
  }

  if (agent && mandate.agent_id !== agent.agent_id) {
    blockers.push(`agent_id_mismatch:${mandate.agent_id}≠${agent.agent_id}`);
  }

  if (isMandateExpired(mandate)) {
    blockers.push("mandate_expired");
  }

  if (!isMandateFresh(mandate, epoch)) {
    blockers.push(`epoch_stale:${mandate.epoch}<${epoch}`);
  }

  if (blockers.length) {
    return { ok: false, blockers };
  }

  const mandate_hash = hashMandateV1(mandate);
  const binding = {
    mandate_hash,
    network,
    policy_contract,
    owner,
    agent_id: mandate.agent_id,
    epoch,
    bound_at_ms: Date.now(),
  };

  return { ok: true, mandate_hash, binding };
}

/**
 * ms → NEAR nanosecond timestamp (U64 string digits).
 * @param {number} ms
 * @returns {string}
 */
export function msToNearNs(ms) {
  return String(BigInt(Math.floor(Number(ms))) * 1_000_000n);
}

/**
 * Compile mandate to full on-chain PolicyLimits shape (preview only).
 * Includes valid_until and token_scope — previously missing.
 *
 * @param {object} mandate
 * @returns {object} PolicyLimits-shaped object
 */
export function compileMandateToPolicyLimits(mandate) {
  assert(mandate, "mandate_required");
  const token_scope = String(mandate.token_scope || "allowlist");
  if (token_scope !== "allowlist" && token_scope !== "any_eligible_token") {
    throw new Error(`invalid_token_scope:${token_scope}`);
  }
  const valid_until_ms = Number(mandate.expires_at_ms || 0);
  if (!Number.isFinite(valid_until_ms) || valid_until_ms <= 0) {
    throw new Error("expires_at_ms_required_for_policy_limits");
  }

  return {
    max_trade_value: String(mandate.max_trade_raw || "0"),
    daily_turnover_limit: String(mandate.daily_turnover_budget_raw || "0"),
    max_pending_exposure: String(mandate.max_pending_exposure_raw || "0"),
    max_slippage_bps: Number(mandate.max_slippage_bps ?? 0),
    allowed_assets: Array.isArray(mandate.allowed_assets) ? [...mandate.allowed_assets] : [],
    allowed_destinations: Array.isArray(mandate.allowed_destinations)
      ? [...mandate.allowed_destinations]
      : [],
    valid_until: msToNearNs(valid_until_ms),
    token_scope,
    allowed_chains: Array.isArray(mandate.allowed_chains) ? [...mandate.allowed_chains] : [],
    allowed_venues: Array.isArray(mandate.allowed_venues) ? [...mandate.allowed_venues] : [],
    max_gas_budget: String(mandate.max_gas_budget || "0"),
  };
}

/**
 * Compile activation preview: which contract methods would be called.
 * Does NOT propose unpause when trading is disabled.
 * Prefer atomic activate_autonomous_mandate when trading_enabled.
 *
 * NOTE: Preview only. NO mainnet mutations.
 *
 * @param {object} mandate
 * @returns {object} activation preview
 */
export function compileActivationPreview(mandate) {
  const methods = [];
  const notes = [];
  const policy_limits = compileMandateToPolicyLimits(mandate);

  if (mandate.trading_enabled) {
    // Prefer single owner signature that sets limits + autonomy + optional unpause.
    methods.push("activate_autonomous_mandate");
    notes.push(
      "Atomic owner activation: set_policy fields + enforce_autonomous_on_agent + autonomous_trading + optional unpause"
    );
    if (mandate.enforcement_map?.trading_enabled === ENFORCEMENT.PLANNED) {
      notes.push("enforcement_map.trading_enabled=PLANNED → enforce_autonomous_on_agent=true inside activate");
    }
  } else {
    methods.push("set_policy");
    notes.push("trading_enabled=false → limits may update but autonomous_trading stays off");
    notes.push("unpause OMITTED: trading-disabled mandate must not accidentally resume agent ops");
  }

  return {
    methods,
    mainnet_mutations: false,
    unpause_included: false,
    note: "Preview only. NO mainnet mutations in this module.",
    notes,
    policy_limits,
    activate_args_preview: mandate.trading_enabled
      ? {
          limits: policy_limits,
          policy_hash: hashMandateV1(mandate),
          strategy_hash: String(mandate.strategy_hash || ""),
          enforce_autonomous_on_agent: true,
          autonomous_trading: true,
          unpause_now: false, // owner must explicitly opt-in; preview defaults safe
        }
      : null,
  };
}

/**
 * Create a deterministic operation ID for replay/idempotency.
 */
export function createMandateOperationId(mandate_hash, operation_type, epoch) {
  const payload = `${mandate_hash}:${operation_type}:${epoch}`;
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 16);
}

export function assertNotExpired(mandate) {
  if (isMandateExpired(mandate)) {
    throw new Error("mandate_expired");
  }
}

export function assertEpochFresh(mandate, currentEpoch) {
  if (!isMandateFresh(mandate, currentEpoch)) {
    throw new Error(`epoch_stale:${mandate.epoch}<${currentEpoch}`);
  }
}
