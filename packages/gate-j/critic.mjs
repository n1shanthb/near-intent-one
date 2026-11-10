/**
 * Gate J — Independent AI Risk Critic.
 * APPROVE is advisory only. REJECT/ABSTAIN fail closed for automation.
 */
import { chatJson, getLlmConfig, getRoleModel } from "./llm.mjs";
import { CRITIC_VERDICTS, REASON, nowIso } from "./types.mjs";

const SYSTEM = `You are NIO's independent Risk Critic. Review the EXACT fitted trade proposal.
You are independent of the Strategist — do not rubber-stamp their thesis.
You do not sign transactions. You cannot override NEAR policy or change owner limits.
Return STRICT JSON:
verdict ("APPROVE"|"REJECT"|"ABSTAIN"),
reasons (string[]),
findings {
  data_quality,
  volatility,
  liquidity_slippage,
  forecast_uncertainty,
  adaptation_undermines_thesis,
  concentration_exposure
},
confidence (0-1).
Fail closed: if data is weak or adaptation destroys the thesis, REJECT or ABSTAIN.`;

export function normalizeCritic(parsed, meta = {}) {
  let verdict = String(parsed?.verdict || "ABSTAIN").toUpperCase();
  if (!CRITIC_VERDICTS.includes(verdict)) verdict = "ABSTAIN";
  return {
    verdict,
    reasons: Array.isArray(parsed?.reasons)
      ? parsed.reasons.map(String)
      : [String(parsed?.reasons || "unspecified")],
    findings: parsed?.findings || {},
    confidence: Number(parsed?.confidence ?? 0),
    model: meta.model || "unknown",
    provider: meta.provider || "unknown",
    timestamp: meta.timestamp || nowIso(),
    advisory_only: true,
    note: "APPROVE cannot override deterministic fitter or NEAR authorization",
  };
}

export async function runCriticLlm({
  market,
  mandate,
  fitResult,
  strategist,
  research = null,
}) {
  const cfg = getLlmConfig();
  const user = JSON.stringify(
    {
      market,
      research,
      mandate_summary: {
        portfolio_id: mandate.portfolio_id,
        per_trade_limit_usdc_raw: mandate.per_trade_limit_usdc_raw,
        revoked: mandate.revoked,
      },
      strategist_proposal: strategist,
      fitter: {
        outcome: fitResult.outcome,
        fitted_proposal: fitResult.fitted_proposal,
        parameters_changed: fitResult.parameters_changed,
        economic_viability: fitResult.economic_viability,
      },
      note: "Assess the EXACT fitted proposal independently. APPROVE is advisory only.",
    },
    null,
    2
  );
  try {
    const llm = await chatJson({
      role: "critic",
      system: SYSTEM,
      user,
      temperature: 0.1,
    });
    const review = normalizeCritic(llm.parsed, {
      model: llm.model,
      provider: llm.provider,
      timestamp: llm.timestamp,
    });
    review.requested_model = llm.requested_model;
    review.request_id = llm.request_id;
    return {
      ok: true,
      review,
      llm: {
        provider: llm.provider,
        role: "critic",
        requested_model: llm.requested_model,
        model: llm.model,
        request_id: llm.request_id,
        latency_ms: llm.latency_ms,
        usage: llm.usage,
        estimated_cost_usd: llm.estimated_cost_usd,
        raw: llm.parsed,
      },
    };
  } catch (e) {
    // Fail closed on timeout / malformed
    return {
      ok: false,
      review: normalizeCritic(
        {
          verdict: "ABSTAIN",
          reasons: [e.code || REASON.LLM_TIMEOUT, String(e.message || e).slice(0, 160)],
        },
        {
          model: getRoleModel("critic"),
          provider: "openrouter",
        }
      ),
      reason: e.code || REASON.LLM_TIMEOUT,
      llm: {
        provider: "openrouter",
        role: "critic",
        requested_model: getRoleModel("critic"),
        model: getRoleModel("critic"),
        configured: cfg.configured,
        error: String(e.message || e).slice(0, 200),
      },
    };
  }
}

export function runCriticFixture(verdict, reasons = []) {
  return {
    ok: true,
    review: normalizeCritic(
      { verdict, reasons, findings: { data_quality: "fixture" }, confidence: 1 },
      { model: "fixture:critic-v1", provider: "fixture" }
    ),
    llm: { provider: "fixture", model: "fixture:critic-v1", note: "not an LLM call" },
  };
}
