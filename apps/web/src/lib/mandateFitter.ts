/** Deterministic Mandate Fitter — mirrors packages/strategy/mandate-fitter.mjs */

export type FitVerdict = "ALLOWED" | "ADAPTED" | "REJECTED";

export type FitInput = {
  proposed_amount: string;
  min_viable_amount: string;
  proposed_asset: string;
  allowed_assets: string[];
  max_trade_value: string;
  max_pending_exposure?: string;
  reserved_pending?: string;
  revoked?: boolean;
};

export type MandateFitResult = {
  verdict: FitVerdict;
  original_amount: string;
  final_amount: string | null;
  parameters_changed: Array<{ field: string; from: string; to: string }>;
  constraints_satisfied: Array<{ name: string; ok: boolean; detail?: string }>;
  rejection_reasons: string[];
  economically_viable: boolean;
  fitter_id: string;
  timestamp: string;
  mode: "live_api" | "dry_run";
};

export function fitMandate(input: FitInput): MandateFitResult {
  const ts = new Date().toISOString();
  const original = BigInt(input.proposed_amount);
  const minViable = BigInt(input.min_viable_amount);
  const maxTrade = BigInt(input.max_trade_value);
  const reserved = BigInt(input.reserved_pending || "0");
  const maxPending = BigInt(input.max_pending_exposure || input.max_trade_value);
  const constraints: MandateFitResult["constraints_satisfied"] = [];
  const changed: MandateFitResult["parameters_changed"] = [];
  const reasons: string[] = [];

  const pack = (
    verdict: FitVerdict,
    finalAmount: string | null,
    viable: boolean
  ): MandateFitResult => ({
    verdict,
    original_amount: original.toString(),
    final_amount: finalAmount,
    parameters_changed: changed,
    constraints_satisfied: constraints,
    rejection_reasons: reasons,
    economically_viable: viable,
    fitter_id: "mandate-fitter-v1",
    timestamp: ts,
    mode: "dry_run",
  });

  if (input.revoked) {
    constraints.push({ ok: false, name: "mandate_active", detail: "revoked" });
    reasons.push("MANDATE_REVOKED");
    return pack("REJECTED", null, false);
  }
  constraints.push({ ok: true, name: "mandate_active" });

  const assetOk = input.allowed_assets.includes(input.proposed_asset);
  constraints.push({
    ok: assetOk,
    name: "allowed_asset",
    detail: input.proposed_asset,
  });
  if (!assetOk) {
    reasons.push("ASSET_NOT_ALLOWLISTED");
    return pack("REJECTED", null, false);
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
    return pack("REJECTED", null, false);
  }

  if (original <= cap) {
    if (original < minViable) {
      reasons.push("BELOW_MIN_VIABLE");
      constraints.push({
        ok: false,
        name: "min_viable_amount",
        detail: `proposed ${original} < min ${minViable}`,
      });
      return pack("REJECTED", null, false);
    }
    constraints.push({ ok: true, name: "min_viable_amount" });
    constraints.push({ ok: true, name: "amount_within_mandate" });
    return pack("ALLOWED", original.toString(), true);
  }

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
    return pack("REJECTED", null, false);
  }

  constraints.push({ ok: true, name: "min_viable_amount" });
  return pack("ADAPTED", adapted.toString(), true);
}

export type ScenarioId = "A_ALLOWED" | "B_ADAPTED" | "C_REJECTED";

export const GATE_J_SCENARIOS: Record<
  ScenarioId,
  {
    id: ScenarioId;
    label: string;
    proposed_amount: string;
    min_viable_amount: string;
    proposed_asset: string;
    allowed_assets: string[];
    max_trade_value: string;
    max_pending_exposure: string;
    thesis: string;
    amount_display: string;
    mandate_display: string;
  }
> = {
  A_ALLOWED: {
    id: "A_ALLOWED",
    label: "ALLOWED — proposal already inside mandate",
    proposed_amount: "20000000",
    min_viable_amount: "5000000",
    proposed_asset: "USDC",
    allowed_assets: ["USDC", "ETH", "NEAR"],
    max_trade_value: "20000000",
    max_pending_exposure: "50000000",
    thesis:
      "Dry-run scenario input (not a live LLM): modest USDC→wNEAR within headroom.",
    amount_display: "$20 USDC",
    mandate_display: "max $20 / asset USDC",
  },
  B_ADAPTED: {
    id: "B_ADAPTED",
    label: "ADAPTED — $100 proposal fitted to $20 mandate",
    proposed_amount: "100000000",
    min_viable_amount: "5000000",
    proposed_asset: "USDC",
    allowed_assets: ["USDC", "ETH", "NEAR"],
    max_trade_value: "20000000",
    max_pending_exposure: "50000000",
    thesis:
      "Dry-run scenario input (not a live LLM): AI wants $100; owner cap $20; still viable at $20.",
    amount_display: "$100 USDC",
    mandate_display: "max $20 / asset USDC",
  },
  C_REJECTED: {
    id: "C_REJECTED",
    label: "REJECTED — adapted size below strategy minimum",
    proposed_amount: "100000000",
    min_viable_amount: "50000000",
    proposed_asset: "USDC",
    allowed_assets: ["USDC", "ETH", "NEAR"],
    max_trade_value: "20000000",
    max_pending_exposure: "50000000",
    thesis:
      "Dry-run scenario input (not a live LLM): AI wants $100; cap $20; strategy needs ≥$50.",
    amount_display: "$100 USDC",
    mandate_display: "max $20 / min viable $50",
  },
};

export function runScenario(scenarioId: ScenarioId) {
  const s = GATE_J_SCENARIOS[scenarioId];
  const fit = fitMandate({
    proposed_amount: s.proposed_amount,
    min_viable_amount: s.min_viable_amount,
    proposed_asset: s.proposed_asset,
    allowed_assets: s.allowed_assets,
    max_trade_value: s.max_trade_value,
    max_pending_exposure: s.max_pending_exposure,
  });
  return { scenario: s, fit };
}

export function usdcDisplay(raw: string | null): string {
  if (raw == null) return "—";
  try {
    const n = Number(BigInt(raw)) / 1e6;
    return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC`;
  } catch {
    return raw;
  }
}
