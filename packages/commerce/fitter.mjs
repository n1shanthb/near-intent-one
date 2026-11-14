/**
 * Commerce Fitter — deterministic price/trust filter (not LLM).
 * External agent output is never trusted to change mandates.
 */
import { parseUsdcAmount } from "./nearAgentMarketClient.mjs";
import { commerceGates } from "./budget.mjs";

export function fitCommerceCandidates(agents, opts = {}) {
  const env = opts.env || process.env;
  const gates = commerceGates(env);
  const allowlist = opts.providerAllowlist || null;
  const need = String(opts.needQuery || "").toLowerCase();
  const results = [];

  for (const a of agents || []) {
    const reasons = [];
    const price = parseUsdcAmount(a.price_amount);
    if (price == null) reasons.push("price_unparsed");
    if (price != null && price > gates.max_price_per_hire_usdc) {
      reasons.push("over_budget_cap");
    }
    if (a.listing_status && a.listing_status !== "live") reasons.push("not_live");
    if (a.funding_paused) reasons.push("funding_paused");
    if (a.available_now === false) reasons.push("not_available_now");
    const pay = (a.payable_with || []).map((x) => String(x).toUpperCase());
    if (pay.length && !pay.includes("USDC")) reasons.push("currency_unsupported");
    if (allowlist?.length && !allowlist.includes(a.agent_id) && !allowlist.includes(a.handle)) {
      reasons.push("not_allowlisted");
    }
    // Soft relevance: description/tags vs need
    const blob = `${a.name} ${a.description} ${(a.tags || []).join(" ")}`.toLowerCase();
    const relevant =
      !need ||
      need.split(/\s+/).filter(Boolean).some((w) => w.length > 2 && blob.includes(w));
    if (!relevant) reasons.push("low_relevance");

    const hardBlock = reasons.some((r) =>
      [
        "over_budget_cap",
        "not_live",
        "funding_paused",
        "currency_unsupported",
        "not_allowlisted",
        "price_unparsed",
      ].includes(r)
    );

    const trustScore =
      (Number(a.delivered_jobs) > 0 ? 0.4 : 0) +
      (Number(a.success_rate) >= 50 ? 0.3 : 0) +
      (a.builder?.verification?.level && a.builder.verification.level !== "none"
        ? 0.2
        : 0) +
      (a.available_now ? 0.1 : 0);

    results.push({
      agent: a,
      price_usdc: price,
      currency: "USDC",
      outcome: hardBlock ? "REJECTED" : reasons.includes("not_available_now") || reasons.includes("low_relevance") ? "ADAPTED" : "ALLOWED",
      reason_codes: reasons,
      trust_score: Number(trustScore.toFixed(3)),
      may_propose: !hardBlock && price != null && price <= gates.max_price_per_hire_usdc,
    });
  }

  function xAvailable(r) {
    // Soft: still include unavailable in candidates list; proposable prefers available_now
    return r.agent.available_now !== false || opts.includeUnavailable === true;
  }

  const proposable = results
    .filter((r) => r.may_propose && xAvailable(r))
    .sort((a, b) => {
      // Demo first-hire: prefer available + lowest price; deliveries are tie-breakers only
      const score = (x) =>
        (x.agent.available_now ? 1_000_000 : 0) -
        Math.round((x.price_usdc || 99) * 10_000) +
        Math.min(Number(x.agent.delivered_jobs) || 0, 50) +
        Math.round(x.trust_score * 10);
      return score(b) - score(a);
    });

  return {
    ok: true,
    evaluated: results.length,
    proposable: proposable.length,
    best: proposable[0] || null,
    candidates: results,
    gates: {
      max_price_per_hire_usdc: gates.max_price_per_hire_usdc,
      payments_enabled: gates.payments_enabled,
    },
  };
}
