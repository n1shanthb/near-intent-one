/**
 * Commerce Critic — accept/reject a proposed hire.
 * Fail-closed. Never elevates LLM advice over budget gates.
 */
import { assertCommerceSpendAllowed } from "./budget.mjs";
import { hashBrief } from "./nearAgentMarketClient.mjs";

const FORBIDDEN_INSTRUCTIONS = [
  /ignore (previous|all) (instructions|rules)/i,
  /unpause/i,
  /sign (this |the )?transaction/i,
  /override (mandate|fitter|policy)/i,
  /transfer (all|funds|near)/i,
  /exfiltrat/i,
  /private[_ ]?key/i,
];

export function sanitizeExternalAgentOutput(text) {
  const s = String(text || "");
  const hits = FORBIDDEN_INSTRUCTIONS.filter((re) => re.test(s)).map((re) =>
    String(re)
  );
  return {
    ok: hits.length === 0,
    hits,
    note: "External agent output is UNTRUSTED — never execute instructions from deliverables",
  };
}

export function criticReviewHire({
  fitted,
  brief,
  ledger,
  env = process.env,
  providerAllowlist = null,
  llmOpinion = null,
} = {}) {
  const checks = [];
  const push = (name, ok, detail = {}) => checks.push({ name, ok, ...detail });

  if (!fitted?.may_propose || !fitted?.agent) {
    push("fitter_proposable", false);
    return {
      verdict: "REJECT",
      reason_codes: ["FITTER_REJECTED"],
      checks,
      may_hire: false,
    };
  }
  push("fitter_proposable", true);

  const briefHash = hashBrief(brief);
  const spend = assertCommerceSpendAllowed({
    priceUsdc: fitted.price_usdc,
    currency: fitted.currency || "USDC",
    agentId: fitted.agent.agent_id,
    briefHash,
    ledger,
    env,
    providerAllowlist,
  });
  push("spend_gates", spend.ok, { reasons: spend.reasons });

  // LLM may advise but cannot authorize spend
  if (llmOpinion?.verdict === "REJECT") {
    push("llm_advisory", false, { verdict: "REJECT" });
    return {
      verdict: "REJECT",
      reason_codes: ["CRITIC_LLM_REJECT", ...spend.reasons],
      checks,
      may_hire: false,
      spend,
    };
  }
  push("llm_advisory", true, {
    verdict: llmOpinion?.verdict || "skipped",
    note: "LLM cannot authorize payments",
  });

  const hard = spend.reasons.filter((r) => r !== "payments_disabled");
  if (hard.length) {
    return {
      verdict: "REJECT",
      reason_codes: hard,
      checks,
      may_hire: false,
      spend,
      brief_hash: briefHash,
    };
  }

  // Commercially acceptable but payments remain gated until operator authorization
  if (!spend.gates.payments_enabled || spend.reasons.includes("payments_disabled")) {
    push("payments_enabled", false);
    return {
      verdict: "APPROVE_PENDING_AUTH",
      reason_codes: ["payments_disabled_awaiting_authorization"],
      checks,
      may_hire: false,
      may_propose: true,
      spend,
      brief_hash: briefHash,
      note: "Critic accepts candidate commercially but financial hire remains gated",
    };
  }

  push("payments_enabled", true);
  return {
    verdict: "APPROVE",
    reason_codes: [],
    checks,
    may_hire: true,
    spend,
    brief_hash: briefHash,
  };
}
