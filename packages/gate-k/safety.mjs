/**
 * Gate K safety overlay — applied ON TOP of on-chain mandate.
 */
import { FIRST_TEST, REASON, DEMO_PREFIX } from "./constants.mjs";

/**
 * Clamp fitted size to Gate K first-test / overlay limits.
 * Never increases size. Never changes pair/thesis.
 */
export function applyGateKSafety({
  mandate,
  fittedProposal,
  portfolioId,
  overlay = FIRST_TEST,
  allowOtherPortfolios = process.env.GATE_K_ALLOW_OTHER_PORTFOLIOS === "1",
}) {
  const checks = [];
  const push = (name, ok, detail = {}) => checks.push({ name, ok, ...detail });

  if (!mandate || mandate.revoked || mandate.paused) {
    return {
      ok: false,
      reason: mandate?.revoked ? "MANDATE_REVOKED" : "POLICY_PAUSED",
      checks,
    };
  }
  if (String(mandate.owner_account || "").startsWith(DEMO_PREFIX)) {
    return { ok: false, reason: "DEMO_PORTFOLIO_FORBIDDEN", checks };
  }
  if (!allowOtherPortfolios && portfolioId !== overlay.portfolio_id) {
    push("portfolio_allowlist", false, { portfolioId, required: overlay.portfolio_id });
    return { ok: false, reason: REASON.WRONG_PORTFOLIO, checks };
  }
  push("portfolio_allowlist", true);

  if (!fittedProposal || fittedProposal.choice !== "TRADE") {
    return { ok: false, reason: "STRATEGIST_NO_TRADE", checks };
  }

  const origin = fittedProposal.pair?.origin;
  const dest = fittedProposal.pair?.destination;
  if (origin !== overlay.pair.origin || dest !== overlay.pair.destination) {
    push("pair", false, { origin, dest });
    return { ok: false, reason: REASON.SAFETY_LIMIT, detail: "pair_not_allowed", checks };
  }
  push("pair", true);

  if (!overlay.networks.includes(fittedProposal.network)) {
    push("network", false, { network: fittedProposal.network });
    return { ok: false, reason: REASON.SAFETY_LIMIT, detail: "network_not_allowed", checks };
  }
  push("network", true);

  let size = BigInt(fittedProposal.proposed_size_usdc_raw || "0");
  const cap = BigInt(overlay.max_trade_usdc_raw);
  const mandateCap = BigInt(mandate.per_trade_limit_usdc_raw || "0");
  const balance = BigInt(mandate.balance_usdc_raw || "0");
  const hard = [cap, mandateCap, balance].reduce((a, b) => (a < b ? a : b));

  const parameters_changed = [];
  if (size > hard) {
    parameters_changed.push({
      field: "proposed_size_usdc_raw",
      from: size.toString(),
      to: hard.toString(),
      reason: "gate_k_safety_cap",
    });
    size = hard;
  }

  const minViable = BigInt(fittedProposal.min_viable_size_usdc_raw || "0");
  if (size < minViable || size <= 0n) {
    push("size_vs_min_viable", false, {
      size: size.toString(),
      minViable: minViable.toString(),
    });
    return {
      ok: false,
      reason: "MIN_VIABLE_NOT_MET",
      checks,
      parameters_changed,
    };
  }
  push("size_vs_min_viable", true, { size: size.toString() });

  return {
    ok: true,
    checks,
    parameters_changed,
    safe_proposal: {
      ...fittedProposal,
      proposed_size_usdc_raw: size.toString(),
      gate_k_cap_usdc_raw: overlay.max_trade_usdc_raw,
    },
  };
}

export function assertSingleFlight({ store, portfolioId }) {
  const s = store.read();
  const inflight = Object.entries(s.executions || {}).filter(
    ([, v]) =>
      v.portfolio_id === portfolioId &&
      (v.status === "IN_FLIGHT" ||
        v.status === "SIGNED_PENDING_BROADCAST" ||
        v.status === "BROADCAST_PENDING_RECONCILE") &&
      v.kind === "gate_k_ai_trade"
  );
  if (inflight.length) {
    return {
      ok: false,
      reason: REASON.SINGLE_FLIGHT,
      inflight: inflight.map(([k, v]) => ({ key: k, status: v.status })),
    };
  }
  const done = Object.values(s.executions || {}).filter(
    (v) =>
      v.portfolio_id === portfolioId &&
      v.kind === "gate_k_ai_trade" &&
      (v.status === "SUCCESS" || v.status === "SIGNED_PENDING_BROADCAST")
  );
  if (done.length >= FIRST_TEST.max_trades && process.env.GATE_K_ALLOW_MULTI !== "1") {
    return { ok: false, reason: REASON.MAX_TRADES, count: done.length };
  }
  return { ok: true };
}
