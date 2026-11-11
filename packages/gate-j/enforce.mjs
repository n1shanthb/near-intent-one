/**
 * Gate J — mandatory final enforcement (deterministic).
 * LLM/Fitter output is NEVER signing authorization.
 * Dry-run by default — does not call NEAR MPC unless explicitly enabled + authorized.
 */
import { fitMandate } from "./fitter.mjs";
import { REASON, nowIso, FINAL_DECISIONS } from "./types.mjs";

/**
 * Independently revalidate mandate + fit before any execution path.
 * Order: mandate hard stops → fitter/strategist outcome → critic → economics.
 * Critic APPROVE cannot override a rejected fitter.
 */
export function finalEnforce({
  proposal,
  mandate,
  market,
  fitResult,
  criticReview,
  dryRun = true,
  allowExecute = false,
}) {
  const ts = nowIso();
  const checks = [];
  const reason_codes = [];

  const push = (name, ok, detail = {}) => checks.push({ name, ok, ...detail });
  const add = (code) => {
    if (code && !reason_codes.includes(code)) reason_codes.push(code);
  };

  // Re-run fitter on current mandate (independent of prior fit snapshot)
  // Critic is NOT passed into refit — critic cannot change feasible set here.
  const refit = fitMandate({
    proposal,
    mandate,
    market,
    critic: null,
  });

  push("refit_outcome", !!refit.outcome, {
    outcome: refit.outcome,
    reason_codes: refit.reason_codes,
  });

  if (mandate.revoked) {
    push("revocation", false);
    return blocked([REASON.MANDATE_REVOKED], checks, ts);
  }
  push("revocation", true);

  if (mandate.signing_revoked) {
    push("signing_revoked", false);
    return blocked([REASON.MANDATE_REVOKED], checks, ts, "signing_revoked");
  }
  push("signing_revoked", true);

  if (mandate.paused) {
    push("pause", false);
    return blocked([REASON.POLICY_PAUSED], checks, ts);
  }
  push("pause", true);

  if (String(mandate.owner_account || "").startsWith("nio-c-")) {
    push("demo_isolation", false);
    return blocked([REASON.ENFORCEMENT_FAIL], checks, ts, "demo portfolio forbidden");
  }
  push("demo_isolation", true);

  // Strategist NO_TRADE / empty feasible set — independent of critic
  if (proposal?.choice === "NO_TRADE") {
    add(REASON.STRATEGIST_NO_TRADE);
    push("strategist_choice", true, { choice: "NO_TRADE" });
  }

  if (refit.outcome === "REJECTED" || !refit.fitted_proposal) {
    add(REASON.FITTER_REJECTED);
    for (const c of refit.reason_codes || []) add(c);
    if (proposal?.choice === "NO_TRADE") add(REASON.STRATEGIST_NO_TRADE);
    push("feasible", false, { reason_codes: refit.reason_codes });

    // Still record critic if present, but do not let APPROVE clear the block
    if (criticReview?.verdict === "REJECT") {
      add(REASON.CRITIC_VETO);
      push("critic", false, { verdict: "REJECT", note: "advisory_after_fitter_reject" });
    } else if (criticReview?.verdict === "ABSTAIN") {
      add(REASON.CRITIC_ABSTAIN);
      push("critic", false, { verdict: "ABSTAIN", note: "advisory_after_fitter_reject" });
    } else if (criticReview?.verdict === "APPROVE") {
      push("critic", true, {
        verdict: "APPROVE",
        note: "APPROVE_ignored_fitter_already_rejected",
      });
    } else {
      push("critic", true, { verdict: criticReview?.verdict || "skipped" });
    }

    return {
      decision: proposal?.choice === "NO_TRADE" ? "NO_TRADE" : "BLOCKED",
      reason_codes,
      checks,
      refit,
      prior_fit: fitResult || null,
      may_sign: false,
      dry_run: true,
      timestamp: ts,
      note: "LLM/Fitter outputs are not signing authorization; fitter reject blocks independently of critic",
    };
  }

  // Feasible set non-empty — critic fail-closed
  if (criticReview?.verdict === "REJECT") {
    push("critic", false, { verdict: "REJECT" });
    return blocked([REASON.CRITIC_VETO], checks, ts);
  }
  if (criticReview?.verdict === "ABSTAIN") {
    push("critic", false, { verdict: "ABSTAIN" });
    return blocked([REASON.CRITIC_ABSTAIN], checks, ts);
  }
  push("critic", true, { verdict: criticReview?.verdict || "skipped" });

  // Prior fit must not have been REJECTED if we somehow have a fitted proposal now
  if (fitResult?.outcome === "REJECTED") {
    push("prior_fit_consistent", false);
    return blocked(
      [REASON.FITTER_REJECTED, REASON.ENFORCEMENT_FAIL],
      checks,
      ts,
      "prior fit rejected"
    );
  }
  push("prior_fit_consistent", true);

  // Quote authenticity / expiry
  const q = refit.fitted_proposal.selected_quote;
  if (q?.deadline && Date.parse(q.deadline) < Date.now() + 30_000) {
    push("quote_binding", false);
    return blocked([REASON.EXPIRED_QUOTE], checks, ts);
  }
  push("quote_binding", true, { has_quote: !!q });

  if (market?.stale) {
    push("market", false);
    return blocked([REASON.STALE_MARKET_DATA], checks, ts);
  }
  push("market", true);

  if (!refit.operation_id) {
    push("idempotency", false);
    return blocked([REASON.REPLAY_PROTECTED], checks, ts);
  }
  push("idempotency", true, { operation_id: refit.operation_id });

  if (!refit.economic_viability?.ok) {
    push("economics", false);
    return blocked([REASON.ECONOMIC_NOT_VIABLE], checks, ts);
  }
  push("economics", true);

  const maySign = allowExecute && !dryRun && refit.outcome !== "REJECTED";
  const decision = maySign ? "EXECUTE" : "EXECUTE_DRY_RUN";
  if (!FINAL_DECISIONS.includes(decision)) throw new Error("bad_decision");

  return {
    decision,
    reason_codes: refit.reason_codes,
    checks,
    refit,
    fitted_proposal: refit.fitted_proposal,
    may_sign: maySign,
    dry_run: dryRun || !allowExecute,
    timestamp: ts,
    policy_hash: mandate.policy_hash,
    portfolio_id: mandate.portfolio_id,
    operation_id: refit.operation_id,
    note: maySign
      ? "Would proceed to existing NEAR contract-controlled signing path"
      : "Dry-run: no NEAR MPC / Sepolia broadcast",
  };
}

function blocked(codes, checks, ts, detail) {
  const reason_codes = Array.isArray(codes) ? codes : [codes];
  return {
    decision: "BLOCKED",
    reason_codes,
    detail,
    checks,
    may_sign: false,
    dry_run: true,
    timestamp: ts,
    note: "LLM/Fitter outputs are not signing authorization",
  };
}
