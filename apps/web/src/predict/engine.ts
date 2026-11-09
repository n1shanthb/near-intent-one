import type { CandidatePolicy } from "../policy/schema";
import type {
  CompareInput,
  Horizon,
  PredictResult,
  ScenarioPack,
  TradeOutcome,
} from "./types";
import { packForHorizon } from "./scenarios";

function usdFromBaseUnits(s: string): number {
  // Assume 6-decimal stable units for demo policies.
  return Number(s) / 1_000_000;
}

function evaluatePolicy(
  policy: CandidatePolicy,
  pack: ScenarioPack,
  horizon: Horizon,
  label: string
): PredictResult {
  const maxTrade = usdFromBaseUnits(policy.max_trade_value);
  const daily = usdFromBaseUnits(policy.daily_turnover_limit);
  const maxPending = usdFromBaseUnits(policy.max_pending_exposure);
  const slipCap = policy.max_slippage_bps;

  let dayKey = "";
  let dayTurnover = 0;
  let equity = 100;
  let peak = 100;
  let maxDd = 0;
  let pending = 0;
  const trades: TradeOutcome[] = [];
  const protections = new Set<string>();

  for (const sig of pack.signals) {
    if (sig.t !== dayKey) {
      dayKey = sig.t;
      dayTurnover = 0;
      pending = Math.max(0, pending * 0.5); // deterministic decay of pending
    }

    let permitted = true;
    let rejectReason: string | undefined;

    if (sig.sizeUsd > maxTrade + 1e-9) {
      permitted = false;
      rejectReason = `size $${sig.sizeUsd} > max_trade $${maxTrade}`;
      protections.add("max_trade_value");
    } else if (dayTurnover + sig.sizeUsd > daily + 1e-9) {
      permitted = false;
      rejectReason = `daily turnover would exceed $${daily}`;
      protections.add("daily_turnover_limit");
    } else if (pending + sig.sizeUsd > maxPending + 1e-9) {
      permitted = false;
      rejectReason = `pending exposure would exceed $${maxPending}`;
      protections.add("max_pending_exposure");
    } else if (pack.slippageBpsAssumption > slipCap) {
      permitted = false;
      rejectReason = `assumed slippage ${pack.slippageBpsAssumption}bps > policy ${slipCap}bps`;
      protections.add("max_slippage_bps");
    }

    if (
      policy.max_drawdown_bps != null &&
      maxDd * 100 >= policy.max_drawdown_bps / 100
    ) {
      // Planned constraint — applied in simulation only.
      permitted = false;
      rejectReason = `planned drawdown stop (${policy.max_drawdown_bps} bps)`;
      protections.add("max_drawdown_bps (planned)");
    }

    const fee = (sig.sizeUsd * pack.feeBps) / 10_000;
    const slipCost = (sig.sizeUsd * pack.slippageBpsAssumption) / 10_000;
    const costUsd = fee + slipCost;
    // Illustrative PnL: small edge minus costs when permitted.
    const edge = permitted ? (sig.side === "buy" ? 0.15 : 0.1) : 0;
    const pnlUsd = permitted ? edge - costUsd : 0;

    if (permitted) {
      dayTurnover += sig.sizeUsd;
      pending += sig.sizeUsd;
      equity += pnlUsd;
      peak = Math.max(peak, equity);
      maxDd = Math.max(maxDd, peak > 0 ? (peak - equity) / peak : 0);
    }

    trades.push({
      t: sig.t,
      side: sig.side,
      sizeUsd: sig.sizeUsd,
      permitted,
      rejectReason,
      pnlUsd: Number(pnlUsd.toFixed(4)),
      costUsd: Number(costUsd.toFixed(4)),
    });
  }

  const permittedCount = trades.filter((t) => t.permitted).length;
  const rejectedCount = trades.length - permittedCount;
  const turnoverUsd = trades
    .filter((t) => t.permitted)
    .reduce((s, t) => s + t.sizeUsd, 0);
  const costsUsd = trades
    .filter((t) => t.permitted)
    .reduce((s, t) => s + t.costUsd, 0);
  const simulatedPnlUsd = trades.reduce((s, t) => s + t.pnlUsd, 0);

  const suggestions: string[] = [];
  if (rejectedCount > permittedCount) {
    suggestions.push(
      "Many signals rejected — consider raising daily turnover only if risk budget allows."
    );
  }
  if (slipCap < pack.slippageBpsAssumption) {
    suggestions.push(
      "Policy slippage is tighter than scenario assumption — expect more rejects in volatile windows."
    );
  }
  if (policy.max_drawdown_bps == null) {
    suggestions.push(
      "Drawdown stop is planned-only; add it in Copilot for simulation stress tests."
    );
  }
  suggestions.push(
    "Illustrative PnL is not a forecast. Do not treat as historical strategy performance."
  );

  return {
    horizon,
    policyLabel: label,
    provenance: pack.provenance,
    kind: "illustrative",
    assumptions: [
      `Fee ${pack.feeBps} bps per fill (assumption)`,
      `Slippage ${pack.slippageBpsAssumption} bps (assumption)`,
      "Signal set is deterministic synthetic — not live strategy output",
      "Starting equity index 100 (unitless illustrative)",
    ],
    trades,
    permittedCount,
    rejectedCount,
    simulatedPnlUsd: Number(simulatedPnlUsd.toFixed(4)),
    maxDrawdownPct: Number((maxDd * 100).toFixed(3)),
    turnoverUsd: Number(turnoverUsd.toFixed(2)),
    costsUsd: Number(costsUsd.toFixed(4)),
    protections: [...protections],
    suggestions,
  };
}

export function runPredict(
  policy: CandidatePolicy,
  horizon: Horizon,
  label = "Candidate"
): PredictResult {
  const pack = packForHorizon(horizon);
  return evaluatePolicy(policy, pack, horizon, label);
}

export function comparePolicies(input: CompareInput): {
  a: PredictResult;
  b: PredictResult;
} {
  return {
    a: evaluatePolicy(
      input.policyA,
      input.pack,
      input.horizon,
      input.labelA ?? "Policy A"
    ),
    b: evaluatePolicy(
      input.policyB,
      input.pack,
      input.horizon,
      input.labelB ?? "Policy B"
    ),
  };
}
