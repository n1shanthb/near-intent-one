/**
 * Wallet Preview for Mandate V1
 * Shared Ledger + Meteor preview (identical hashes, contract args).
 * 
 * NO mainnet mutations. Preview only.
 * signing_enabled: false by default.
 */

import { strict as assert } from "node:assert";
import { hashMandateV1, compileMandateToPolicyLimits, bindMandateV1 } from "./compiler.mjs";
import { validateMandateV1 } from "./schema.mjs";

/**
 * Build Ledger wallet mandate preview.
 * 
 * @param {object} mandate
 * @returns {object} preview
 */
export function buildLedgerMandatePreview(mandate) {
  const validation = validateMandateV1(mandate);
  const blockers = [];

  if (!validation.ok) {
    blockers.push(...validation.reasons);
  }

  // Network checks
  if (!mandate.network || mandate.network === "testnet") {
    blockers.push("mainnet_only");
  }

  // Owner mismatch check (placeholder - actual owner must be injected)
  // This is a preview, so we don't enforce owner here

  const mandate_hash = hashMandateV1(mandate);
  const policy_limits = compileMandateToPolicyLimits(mandate);

  return {
    wallet_type: "LEDGER",
    mandate_hash,
    policy_limits,
    network: mandate.network,
    policy_contract: mandate.policy_contract,
    owner: mandate.owner,
    mainnet_review_only: true,
    signing_enabled: false,
    blockers: blockers.length ? blockers : null,
  };
}

/**
 * Build Meteor wallet mandate preview.
 * 
 * Produces identical mandate_hash and contract args as Ledger.
 * 
 * @param {object} mandate
 * @returns {object} preview
 */
export function buildMeteorMandatePreview(mandate) {
  const validation = validateMandateV1(mandate);
  const blockers = [];

  if (!validation.ok) {
    blockers.push(...validation.reasons);
  }

  // Network checks
  if (!mandate.network || mandate.network === "testnet") {
    blockers.push("mainnet_only");
  }

  // Owner mismatch check (placeholder - actual owner must be injected)
  // This is a preview, so we don't enforce owner here

  const mandate_hash = hashMandateV1(mandate);
  const policy_limits = compileMandateToPolicyLimits(mandate);

  return {
    wallet_type: "METEOR",
    mandate_hash,
    policy_limits,
    network: mandate.network,
    policy_contract: mandate.policy_contract,
    owner: mandate.owner,
    mainnet_review_only: true,
    signing_enabled: false,
    blockers: blockers.length ? blockers : null,
  };
}

/**
 * Verify that Ledger and Meteor previews produce identical mandate_hash.
 * 
 * @param {object} mandate
 * @returns {boolean} true if identical
 */
export function verifyWalletPreviewEquivalence(mandate) {
  const ledger = buildLedgerMandatePreview(mandate);
  const meteor = buildMeteorMandatePreview(mandate);

  return (
    ledger.mandate_hash === meteor.mandate_hash &&
    JSON.stringify(ledger.policy_limits) === JSON.stringify(meteor.policy_limits)
  );
}
