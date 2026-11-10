/**
 * Deterministic Mandate Fitter (Gate J).
 * Finds the best viable version of an AI proposal inside owner rules.
 * No LLM. No fabricated receipts.
 */

/**
 * @typedef {object} FitInput
 * @property {string} proposed_amount
 * @property {string} min_viable_amount
 * @property {string} proposed_asset
 * @property {string[]} allowed_assets
 * @property {string} max_trade_value
 * @property {string} [max_pending_exposure]
 * @property {string} [reserved_pending]
 * @property {boolean} [revoked]
 */

/**
 * @param {FitInput} input
 */
export function fitMandate(input) {
  const ts = new Date().toISOString();
  const original = BigInt(input.proposed_amount);
  const minViable = BigInt(input.min_viable_amount);
  const maxTrade = BigInt(input.max_trade_value);
  const reserved = BigInt(input.reserved_pending || "0");
  const maxPending = BigInt(input.max_pending_exposure || input.max_trade_value);
  const constraints = [];
  const changed = [];
  const reasons = [];

  if (input.revoked) {
    constraints.push({ ok: false, name: "mandate_active", detail: "revoked" });
    return pack("REJECTED", original, null, changed, constraints, reasons.concat("MANDATE_REVOKED"), false, ts);
  }
  constraints.push({ ok: true, name: "mandate_active" });

  const assetOk = (input.allowed_assets || []).includes(input.proposed_asset);
  constraints.push({
    ok: assetOk,
    name: "allowed_asset",
    detail: input.proposed_asset,
  });
  if (!assetOk) {
    reasons.push("ASSET_NOT_ALLOWLISTED");
    return pack("REJECTED", original, null, changed, constraints, reasons, false, ts);
  }

  const headroomPending = maxPending > reserved ? maxPending - reserved : 0n;
  const cap = maxTrade < headroomPending ? maxTrade : headroomPending;
  constraints.push({
    ok: true,
    name: "max_trade_value",
    detail: maxTrade.toString(),
  });
  constraints.push({
    ok: headroomPending > 0n,
    name: "pending_exposure_headroom",
    detail: headroomPending.toString(),
  });

  if (cap <= 0n) {
    reasons.push("NO_EXPOSURE_HEADROOM");
    return pack("REJECTED", original, null, changed, constraints, reasons, false, ts);
  }

  if (original <= cap) {
    if (original < minViable) {
      reasons.push("BELOW_MIN_VIABLE");
      constraints.push({
        ok: false,
        name: "min_viable_amount",
        detail: `proposed ${original} < min ${minViable}`,
      });
      return pack("REJECTED", original, null, changed, constraints, reasons, false, ts);
    }
    constraints.push({ ok: true, name: "min_viable_amount" });
    constraints.push({ ok: true, name: "amount_within_mandate" });
    return pack("ALLOWED", original, original.toString(), changed, constraints, reasons, true, ts);
  }

  // Adapt down to mandate cap
  const adapted = cap;
  changed.push({
    field: "amount",
    from: original.toString(),
    to: adapted.toString(),
  });
  constraints.push({
    ok: true,
    name: "amount_adapted_to_mandate",
    detail: `capped ${original} → ${adapted}`,
  });

  if (adapted < minViable) {
    constraints.push({
      ok: false,
      name: "min_viable_amount",
      detail: `adapted ${adapted} < min ${minViable}`,
    });
    reasons.push("ADAPTED_BELOW_MIN_VIABLE");
    return pack("REJECTED", original, null, changed, constraints, reasons, false, ts);
  }

  constraints.push({ ok: true, name: "min_viable_amount" });
  return pack("ADAPTED", original, adapted.toString(), changed, constraints, reasons, true, ts);
}

function pack(verdict, original, finalAmount, changed, constraints, reasons, viable, ts) {
  return {
    verdict,
    original_amount: original.toString(),
    final_amount: finalAmount,
    parameters_changed: changed,
    constraints_satisfied: constraints,
    rejection_reasons: reasons,
    economically_viable: viable,
    fitter_id: "mandate-fitter-v1",
    timestamp: ts,
  };
}

/** Canonical judge scenarios (USDC 6 decimals). */
export const GATE_J_SCENARIOS = {
  A_ALLOWED: {
    id: "A_ALLOWED",
    label: "ALLOWED — proposal already inside mandate",
    proposed_amount: "20000000", // $20
    min_viable_amount: "5000000", // $5
    proposed_asset: "USDC",
    allowed_assets: ["USDC", "ETH", "NEAR"],
    max_trade_value: "20000000", // $20
    max_pending_exposure: "50000000",
    thesis: "Dry-run: modest USDC→wNEAR rotation within existing headroom.",
  },
  B_ADAPTED: {
    id: "B_ADAPTED",
    label: "ADAPTED — $100 proposal fitted to $20 mandate",
    proposed_amount: "100000000", // $100
    min_viable_amount: "5000000", // $5
    proposed_asset: "USDC",
    allowed_assets: ["USDC", "ETH", "NEAR"],
    max_trade_value: "20000000", // $20
    max_pending_exposure: "50000000",
    thesis: "Dry-run: AI wants $100; owner cap $20; strategy still viable at $20.",
  },
  C_REJECTED: {
    id: "C_REJECTED",
    label: "REJECTED — adapted size below strategy minimum",
    proposed_amount: "100000000", // $100
    min_viable_amount: "50000000", // $50
    proposed_asset: "USDC",
    allowed_assets: ["USDC", "ETH", "NEAR"],
    max_trade_value: "20000000", // $20
    max_pending_exposure: "50000000",
    thesis: "Dry-run: AI wants $100; cap $20; strategy needs ≥$50 — refuse.",
  },
};

export function runScenario(scenarioId) {
  const s = GATE_J_SCENARIOS[scenarioId];
  if (!s) throw new Error(`unknown_scenario:${scenarioId}`);
  const fit = fitMandate({
    proposed_amount: s.proposed_amount,
    min_viable_amount: s.min_viable_amount,
    proposed_asset: s.proposed_asset,
    allowed_assets: s.allowed_assets,
    max_trade_value: s.max_trade_value,
    max_pending_exposure: s.max_pending_exposure,
  });
  return { scenario: s, fit: { ...fit, mode: "dry_run" } };
}
