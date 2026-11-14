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
 * @param {object} params.mandate
 * @param {string} params.network
 * @param {string} params.policy_contract
 * @param {string} params.owner
 * @param {object} params.agent
 * @param {number} params.epoch - current epoch for replay protection
 * @returns {{ ok: true, mandate_hash: string, binding: object } | { ok: false, blockers: string[] }}
 */
export function bindMandateV1({ mandate, network, policy_contract, owner, agent, epoch }) {
  const blockers = [];

  // Validate mandate
  const validation = validateMandateV1(mandate);
  if (!validation.ok) {
    blockers.push(...validation.reasons);
  }

  // Network mismatch
  if (mandate.network !== network) {
    blockers.push(`network_mismatch:${mandate.network}≠${network}`);
  }

  // Policy contract mismatch
  if (mandate.policy_contract !== policy_contract) {
    blockers.push(`policy_contract_mismatch:${mandate.policy_contract}≠${policy_contract}`);
  }

  // Owner mismatch
  if (mandate.owner !== owner) {
    blockers.push(`owner_mismatch:${mandate.owner}≠${owner}`);
  }

  // Agent mismatch
  if (agent && mandate.agent_id !== agent.agent_id) {
    blockers.push(`agent_id_mismatch:${mandate.agent_id}≠${agent.agent_id}`);
  }

  // Expired
  if (isMandateExpired(mandate)) {
    blockers.push("mandate_expired");
  }

  // Stale epoch
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
 * Compile mandate to PolicyLimits-shaped object for contract preview.
 * 
 * NOTE: This is a PREVIEW only. NO mainnet mutations.
 * 
 * @param {object} mandate
 * @returns {object} PolicyLimits-shaped object
 */
export function compileMandateToPolicyLimits(mandate) {
  return {
    max_trade_value: mandate.max_trade_raw,
    daily_turnover_limit: mandate.daily_turnover_budget_raw,
    max_pending_exposure: mandate.max_pending_exposure_raw,
    max_gas_budget: mandate.max_gas_budget,
    max_slippage_bps: mandate.max_slippage_bps,
    allowed_chains: mandate.allowed_chains,
    allowed_assets: mandate.allowed_assets,
    allowed_venues: mandate.allowed_venues,
    allowed_destinations: mandate.allowed_destinations,
  };
}

/**
 * Compile activation preview: which contract methods would be called.
 * 
 * NOTE: This is a PREVIEW only. NO mainnet mutations.
 * 
 * @param {object} mandate
 * @returns {object} activation preview
 */
export function compileActivationPreview(mandate) {
  const methods = [];

  // PolicyLimits update (if trading enabled)
  if (mandate.trading_enabled) {
    methods.push("set_policy");
  }

  // Autonomous trading flag (off-chain only unless enforce_autonomous_on_agent)
  if (mandate.trading_enabled) {
    methods.push("set_autonomous_trading");
    if (mandate.enforcement_map?.trading_enabled === ENFORCEMENT.PLANNED) {
      methods.push("set_enforce_autonomous_on_agent");
    }
  }

  // Unpause (if paused)
  methods.push("unpause");

  return {
    methods,
    mainnet_mutations: false,
    note: "Preview only. NO mainnet mutations in this module.",
    policy_limits: compileMandateToPolicyLimits(mandate),
  };
}

/**
 * Create a deterministic operation ID for replay/idempotency.
 * 
 * @param {string} mandate_hash
 * @param {string} operation_type - e.g. "activate", "revoke", "pause"
 * @param {number} epoch
 * @returns {string} operation_id
 */
export function createMandateOperationId(mandate_hash, operation_type, epoch) {
  const payload = `${mandate_hash}:${operation_type}:${epoch}`;
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 16);
}

/**
 * Assert that mandate is not expired.
 * 
 * @param {object} mandate
 * @throws {Error} if expired
 */
export function assertNotExpired(mandate) {
  if (isMandateExpired(mandate)) {
    throw new Error("mandate_expired");
  }
}

/**
 * Assert that mandate epoch is fresh.
 * 
 * @param {object} mandate
 * @param {number} currentEpoch
 * @throws {Error} if stale
 */
export function assertEpochFresh(mandate, currentEpoch) {
  if (!isMandateFresh(mandate, currentEpoch)) {
    throw new Error(`epoch_stale:${mandate.epoch}<${currentEpoch}`);
  }
}
