/**
 * Gate J pipeline:
 * Verified market → Researcher LLM → Strategist LLM → Mandate Fitter →
 * Risk Critic LLM → Deterministic enforcement.
 * Dry-run by default. Never treats LLM/fitter as signing auth.
 */
import { fitMandate } from "./fitter.mjs";
import { runResearcherLlm } from "./researcher.mjs";
import { runStrategistLlm, runStrategistFixture } from "./strategist.mjs";
import { runCriticLlm, runCriticFixture } from "./critic.mjs";
import { finalEnforce } from "./enforce.mjs";
import { fetchMarketSnapshot } from "./market.mjs";
import { nowIso } from "./types.mjs";
import { getLlmConfig, getSpendState } from "./llm.mjs";

/**
 * @param {object} opts
 * @param {object} opts.mandate — authoritative policy-derived mandate
 * @param {object} [opts.balances]
 * @param {object} [opts.fixtureProposal] — skip LLM strategist
 * @param {object} [opts.marketFixture]
 * @param {"APPROVE"|"REJECT"|"ABSTAIN"|null} [opts.criticFixture]
 * @param {boolean} [opts.useLlm=false]
 * @param {boolean} [opts.dryRun=true]
 * @param {boolean} [opts.allowExecute=false]
 * @param {boolean} [opts.useResearcher=true] — when useLlm
 */
export async function runGateJPipeline(opts) {
  const {
    mandate,
    balances = {},
    fixtureProposal = null,
    marketFixture = null,
    criticFixture = null,
    useLlm = false,
    dryRun = true,
    allowExecute = false,
    forecast = null,
    useResearcher = true,
  } = opts;

  const llmCfg = getLlmConfig();
  const trace = {
    gate: "J",
    dry_run: dryRun,
    allow_execute: allowExecute,
    started_at: nowIso(),
    llm_provider: llmCfg.provider,
    llm_configured: llmCfg.configured,
    llm_models: llmCfg.models,
    no_signing: true,
  };

  const market = await fetchMarketSnapshot({ fixture: marketFixture });
  trace.market = {
    as_of: market.as_of,
    stale: market.stale,
    sources: market.sources,
    near_usd: market.near_usd ?? null,
    usdc_usd: market.usdc_usd ?? null,
    volatility_bps_1h: market.volatility_bps_1h,
  };

  // 0) Researcher (LLM) — only on live path; never labeled as fixture AI
  let research = null;
  if (useLlm && useResearcher && !fixtureProposal) {
    const researcherResult = await runResearcherLlm({ market });
    trace.researcher = {
      ok: researcherResult.ok,
      reason: researcherResult.reason || null,
      error: researcherResult.error || null,
      research: researcherResult.research,
      llm: researcherResult.llm,
    };
    if (!researcherResult.ok) {
      trace.strategist = null;
      trace.fitter = null;
      trace.critic = null;
      trace.enforcement = {
        decision: "NO_TRADE",
        reason_codes: [researcherResult.reason || "RESEARCHER_FAIL"],
        may_sign: false,
      };
      trace.spend = getSpendState();
      trace.finished_at = nowIso();
      return trace;
    }
    research = researcherResult.research;
  } else {
    trace.researcher = {
      ok: true,
      skipped: true,
      note: useLlm
        ? "researcher skipped (fixture strategist path)"
        : "fixture mode — no LLM researcher",
    };
  }

  // 1) Strategist
  let strategistResult;
  if (useLlm && !fixtureProposal) {
    strategistResult = await runStrategistLlm({
      market,
      mandate,
      balances,
      forecast,
      research,
    });
  } else {
    strategistResult = runStrategistFixture(
      fixtureProposal || {
        choice: "NO_TRADE",
        proposed_size_usd: 0,
        min_viable_size_usd: 0,
        thesis: "no fixture",
      }
    );
  }
  trace.strategist = {
    ok: strategistResult.ok,
    reason: strategistResult.reason || null,
    error: strategistResult.error || null,
    llm: strategistResult.llm,
    proposal: strategistResult.proposal,
  };

  if (!strategistResult.ok || !strategistResult.proposal) {
    trace.fitter = null;
    trace.critic = null;
    trace.enforcement = {
      decision: "NO_TRADE",
      reason_codes: [strategistResult.reason || "STRATEGIST_FAIL"],
      may_sign: false,
    };
    trace.spend = getSpendState();
    trace.finished_at = nowIso();
    return trace;
  }

  // 2) Fitter (deterministic) — before critic so critic sees fitted proposal
  const fit1 = fitMandate({
    proposal: strategistResult.proposal,
    mandate,
    market,
    critic: null,
  });
  trace.fitter = fit1;

  // 3) Critic reviews fitted proposal (or original if rejected)
  let criticResult;
  if (criticFixture) {
    criticResult = runCriticFixture(criticFixture, [`fixture:${criticFixture}`]);
  } else if (useLlm) {
    criticResult = await runCriticLlm({
      market,
      mandate,
      fitResult: fit1,
      strategist: strategistResult.proposal,
      research,
    });
  } else {
    criticResult = runCriticFixture("APPROVE", ["default_fixture_approve"]);
  }
  trace.critic = {
    ok: criticResult.ok,
    reason: criticResult.reason || null,
    review: criticResult.review,
    llm: criticResult.llm,
  };

  // Re-fit with critic fail-closed
  const fit2 = fitMandate({
    proposal: strategistResult.proposal,
    mandate,
    market,
    critic: criticResult.review,
  });
  trace.fitter_after_critic = fit2;

  // 4) Final enforcement
  const enforcement = finalEnforce({
    proposal: strategistResult.proposal,
    mandate,
    market,
    fitResult: fit2,
    criticReview: criticResult.review,
    dryRun,
    allowExecute,
  });
  trace.enforcement = enforcement;
  trace.spend = getSpendState();
  trace.finished_at = nowIso();
  trace.summary = {
    fitter_outcome: fit2.outcome,
    critic_verdict: criticResult.review.verdict,
    final_decision: enforcement.decision,
    may_sign: enforcement.may_sign,
    operation_id: enforcement.operation_id || fit2.operation_id,
    models: {
      researcher: trace.researcher?.llm?.model || null,
      strategist: strategistResult.llm?.model || null,
      critic: criticResult.llm?.model || criticResult.review?.model || null,
    },
  };
  return trace;
}
