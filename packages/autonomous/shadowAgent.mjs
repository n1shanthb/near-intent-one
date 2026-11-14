/**
 * Autonomous Agent Loop (shadow / dry-run)
 * Researcher → Strategist → Deterministic Fitter → Risk Critic → Policy Guard
 *
 * LIVE_LLM: real OpenRouter via Gate J (packages/gate-j). No mock fallback.
 * fixture: deterministic offline path for unit tests only.
 */

import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import { runGateJPipeline } from "../gate-j/pipeline.mjs";
import { getLlmConfig, getSpendState, loadServicesEnv } from "../gate-j/llm.mjs";
import { mandateV1ToGateJ } from "./mandateAdapter.mjs";
import { hashMandateV1 } from "../mandate/v1/compiler.mjs";

export const MODE = Object.freeze({
  SHADOW: "SHADOW",
  DRY_RUN: "DRY_RUN",
});

export const LLM_MODE = Object.freeze({
  FIXTURE: "fixture",
  LIVE_LLM: "LIVE_LLM",
});

export const ACTION = Object.freeze({
  HOLD: "HOLD",
  WAIT: "WAIT",
  BUY_DATA: "BUY_DATA",
  TRADE: "TRADE",
  NO_TRADE: "NO_TRADE",
});

export const REASON = Object.freeze({
  NO_OPPORTUNITY: "NO_OPPORTUNITY",
  INSUFFICIENT_DATA: "INSUFFICIENT_DATA",
  STALE_MARKET: "STALE_MARKET",
  OVER_BUDGET: "OVER_BUDGET",
  MANDATE_BLOCKED: "MANDATE_BLOCKED",
  ECONOMIC_NOT_VIABLE: "ECONOMIC_NOT_VIABLE",
  CRITIC_VETO: "CRITIC_VETO",
  GUARD_BLOCKED: "GUARD_BLOCKED",
  OPPORTUNITY_FOUND: "OPPORTUNITY_FOUND",
  FITTER_REJECTED: "FITTER_REJECTED",
  FITTER_ADAPTED: "FITTER_ADAPTED",
  PROVIDER_FAILURE: "PROVIDER_FAILURE",
  LLM_NOT_CONFIGURED: "LLM_NOT_CONFIGURED",
  UNKNOWN_BLOCKS_SPEND: "UNKNOWN_BLOCKS_SPEND",
  COST_AWARE_NO_TRADE: "COST_AWARE_NO_TRADE",
});

const PROMPT_VERSION = "nio_autonomous_gate_j_v1";

/**
 * @param {object} opts
 * @param {object} opts.mandate
 * @param {object} opts.journal — { append(entry) }
 * @param {string} [opts.mode]
 * @param {string} [opts.llmMode] — fixture | LIVE_LLM
 * @param {boolean} [opts.unknownBlocksSpend]
 */
export function createShadowAgent(opts) {
  const {
    mandate,
    journal,
    mode = MODE.SHADOW,
    llmMode = LLM_MODE.FIXTURE,
    unknownBlocksSpend = false,
  } = opts;
  assert.equal(mode, MODE.SHADOW, "only_shadow_mode_supported");
  assert(mandate, "mandate_required");
  assert(journal, "journal_required");
  assert(
    llmMode === LLM_MODE.FIXTURE || llmMode === LLM_MODE.LIVE_LLM,
    "invalid_llm_mode"
  );

  return {
    mode,
    llmMode,
    mandate,
    journal,
    unknownBlocksSpend: Boolean(unknownBlocksSpend),
    state: {
      spent_today_raw: "0",
      pending_exposure_raw: "0",
      commerce_budget_raw: String(mandate.commerce_budget_raw || "0"),
      commerce_spent_raw: "0",
      openrouter_spent_usd: 0,
      openrouter_requests_today: 0,
      recent_operation_sizes: [],
      balance_usdc_raw: String(mandate.total_trading_budget_raw || "0"),
      paused: false,
      revoked: false,
    },
  };
}

function marketFreshnessOk(market, maxAgeMs = 120_000) {
  const asOf = market?.as_of || market?.sources?.[0]?.timestamp_ms;
  if (!asOf) return { ok: false, reason: REASON.STALE_MARKET };
  const ts = typeof asOf === "number" ? asOf : Date.parse(asOf);
  if (!Number.isFinite(ts)) return { ok: false, reason: REASON.STALE_MARKET };
  if (Date.now() - ts > maxAgeMs) return { ok: false, reason: REASON.STALE_MARKET };
  if (market.stale === true) return { ok: false, reason: REASON.STALE_MARKET };
  return { ok: true };
}

function mapEnforcementToAction(trace) {
  const decision = trace?.enforcement?.decision || "NO_TRADE";
  const fitter = trace?.fitter_after_critic || trace?.fitter;
  const criticVerdict = trace?.critic?.review?.verdict || trace?.summary?.critic_verdict;

  if (
    decision === "TRADE" ||
    decision === "ALLOW" ||
    decision === "EXECUTE" ||
    decision === "EXECUTE_DRY_RUN"
  ) {
    // Shadow never executes live — record TRADE intent only when pipeline allows
    if (fitter?.outcome === "REJECTED") {
      return { action: ACTION.HOLD, reason: REASON.FITTER_REJECTED };
    }
    if (criticVerdict === "REJECT" || criticVerdict === "NO_TRADE") {
      return { action: ACTION.HOLD, reason: REASON.CRITIC_VETO };
    }
    return {
      action: ACTION.TRADE,
      reason:
        fitter?.outcome === "ADAPTED" ? REASON.FITTER_ADAPTED : REASON.OPPORTUNITY_FOUND,
    };
  }

  const codes = trace?.enforcement?.reason_codes || [];
  if (codes.includes("STALE_MARKET") || codes.includes("MARKET_STALE")) {
    return { action: ACTION.HOLD, reason: REASON.STALE_MARKET };
  }
  if (codes.some((c) => String(c).includes("BUDGET") || String(c).includes("SPEND"))) {
    return { action: ACTION.HOLD, reason: REASON.OVER_BUDGET };
  }
  if (fitter?.outcome === "REJECTED") {
    const rc = fitter.reason_codes?.[0] || "";
    if (String(rc).includes("NO_TRADE") || String(rc).includes("STRATEGIST_NO_TRADE")) {
      return { action: ACTION.NO_TRADE, reason: REASON.NO_OPPORTUNITY };
    }
    return { action: ACTION.HOLD, reason: REASON.FITTER_REJECTED };
  }
  return { action: ACTION.NO_TRADE, reason: REASON.NO_OPPORTUNITY };
}

function decisionHash(payload) {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Run one autonomous tick.
 * @param {object} agent
 * @param {object} market
 * @param {object} [opts]
 */
export async function runShadowTick(agent, market, opts = {}) {
  const { mandate, journal, state, llmMode } = agent;
  const started_at = new Date().toISOString();
  const mandate_hash = hashMandateV1(mandate);

  if (agent.unknownBlocksSpend) {
    const decision = {
      action: ACTION.HOLD,
      reason: REASON.UNKNOWN_BLOCKS_SPEND,
      timestamp_ms: Date.now(),
      llm_mode: llmMode,
      mandate_hash,
      decision_hash: "blocked_unknown",
    };
    await journal.append({ kind: "decision", ...decision });
    return decision;
  }

  const dailyCapUsd = Number(mandate.openrouter_daily_usd_micros || 0) / 1_000_000;
  if (dailyCapUsd > 0 && state.openrouter_spent_usd >= dailyCapUsd) {
    const decision = {
      action: ACTION.HOLD,
      reason: "openrouter_spend_cap",
      timestamp_ms: Date.now(),
      llm_mode: llmMode,
      mandate_hash,
      decision_hash: "spend_cap",
    };
    await journal.append({ kind: "decision", ...decision });
    return decision;
  }

  if (
    mandate.openrouter_max_requests_per_day > 0 &&
    state.openrouter_requests_today >= mandate.openrouter_max_requests_per_day
  ) {
    const decision = {
      action: ACTION.HOLD,
      reason: "openrouter_request_cap",
      timestamp_ms: Date.now(),
      llm_mode: llmMode,
      mandate_hash,
      decision_hash: "request_cap",
    };
    await journal.append({ kind: "decision", ...decision });
    return decision;
  }

  const fresh = marketFreshnessOk(market, opts.maxMarketAgeMs ?? 180_000);
  if (!fresh.ok && llmMode === LLM_MODE.LIVE_LLM) {
    const decision = {
      action: ACTION.HOLD,
      reason: fresh.reason,
      timestamp_ms: Date.now(),
      llm_mode: llmMode,
      mandate_hash,
      decision_hash: "stale_market",
    };
    await journal.append({ kind: "decision", ...decision });
    return decision;
  }

  loadServicesEnv();
  const llmCfg = getLlmConfig();

  if (llmMode === LLM_MODE.LIVE_LLM) {
    if (!llmCfg.configured) {
      const err = new Error("LIVE_LLM requested but OPENROUTER_API_KEY not configured");
      err.code = REASON.LLM_NOT_CONFIGURED;
      await journal.append({
        kind: "error",
        reason: REASON.LLM_NOT_CONFIGURED,
        timestamp_ms: Date.now(),
      });
      throw err;
    }
  }

  const gateMandate = mandateV1ToGateJ(mandate, state);
  const spendBefore = getSpendState();

  let trace;
  try {
    if (llmMode === LLM_MODE.LIVE_LLM) {
      trace = await runGateJPipeline({
        mandate: gateMandate,
        balances: {
          usdc_raw: state.balance_usdc_raw,
        },
        useLlm: true,
        dryRun: true,
        allowExecute: false,
        marketFixture: market,
        useResearcher: true,
      });
    } else {
      // Fixture path: no live LLM; cost-aware default HOLD / NO_TRADE
      trace = await runGateJPipeline({
        mandate: gateMandate,
        balances: { usdc_raw: state.balance_usdc_raw },
        useLlm: false,
        dryRun: true,
        allowExecute: false,
        marketFixture: market,
        fixtureProposal: opts.fixtureProposal || {
          choice: "NO_TRADE",
          proposed_size_usd: 0,
          proposed_size_usdc_raw: "0",
          min_viable_size_usd: 0,
          thesis: "fixture_default_no_trade",
          thesis_id: "fixture_no_trade",
        },
        criticFixture: opts.criticFixture || "ABSTAIN",
      });
    }
  } catch (err) {
    await journal.append({
      kind: "error",
      reason: REASON.PROVIDER_FAILURE,
      error: String(err.message || err).slice(0, 500),
      timestamp_ms: Date.now(),
    });
    const decision = {
      action: ACTION.HOLD,
      reason: REASON.PROVIDER_FAILURE,
      error: String(err.message || err).slice(0, 300),
      timestamp_ms: Date.now(),
      llm_mode: llmMode,
      mandate_hash,
      prompt_version: PROMPT_VERSION,
      decision_hash: "provider_fail",
    };
    await journal.append({ kind: "decision", ...decision });
    return decision;
  }

  const spendAfter = getSpendState();
  const deltaUsd = Math.max(0, (spendAfter.usd || 0) - (spendBefore.usd || 0));
  const deltaCalls = Math.max(0, (spendAfter.calls || 0) - (spendBefore.calls || 0));
  state.openrouter_spent_usd += deltaUsd;
  state.openrouter_requests_today += deltaCalls;

  // Cost-aware: if remaining LLM budget cannot fund another full cycle, prefer NO_TRADE
  const remainingUsd = dailyCapUsd > 0 ? dailyCapUsd - state.openrouter_spent_usd : Infinity;
  let mapped = mapEnforcementToAction(trace);
  if (
    mapped.action === ACTION.TRADE &&
    dailyCapUsd > 0 &&
    remainingUsd < Math.max(0.01, deltaUsd)
  ) {
    mapped = { action: ACTION.NO_TRADE, reason: REASON.COST_AWARE_NO_TRADE };
  }

  const models = {
    researcher: trace?.summary?.models?.researcher || llmCfg.models.researcher,
    strategist: trace?.summary?.models?.strategist || llmCfg.models.strategist,
    critic: trace?.summary?.models?.critic || llmCfg.models.critic,
  };

  const evidence = {
    started_at,
    finished_at: trace?.finished_at || new Date().toISOString(),
    prompt_version: PROMPT_VERSION,
    llm_mode: llmMode,
    llm_provider: llmCfg.provider,
    models,
    researcher: sanitizeLlm(trace?.researcher),
    strategist: sanitizeLlm(trace?.strategist),
    fitter: summarizeFitter(trace?.fitter),
    fitter_after_critic: summarizeFitter(trace?.fitter_after_critic),
    critic: sanitizeLlm(trace?.critic),
    enforcement: trace?.enforcement || null,
    market: trace?.market || null,
    spend: {
      delta_usd: Number(deltaUsd.toFixed(6)),
      session_usd: spendAfter.usd,
      session_calls: spendAfter.calls,
      openrouter_spent_usd: Number(state.openrouter_spent_usd.toFixed(6)),
      openrouter_requests_today: state.openrouter_requests_today,
    },
  };

  const hashPayload = {
    mandate_hash,
    action: mapped.action,
    reason: mapped.reason,
    fitter_outcome: evidence.fitter_after_critic?.outcome || evidence.fitter?.outcome,
    enforcement: evidence.enforcement?.decision,
    models,
    prompt_version: PROMPT_VERSION,
    finished_at: evidence.finished_at,
  };
  const decision_hash = decisionHash(hashPayload);

  const decision = {
    action: mapped.action,
    reason: mapped.reason,
    strategy: {
      action: mapped.action,
      proposed_size_usdc_raw:
        evidence.fitter_after_critic?.fitted_size_raw ||
        evidence.strategist?.proposal?.proposed_size_usdc_raw ||
        "0",
      reasoning: evidence.strategist?.proposal?.thesis || "",
    },
    research: evidence.researcher?.research || null,
    critic: evidence.critic?.review || null,
    fitter: evidence.fitter_after_critic || evidence.fitter,
    guard: {
      ok: evidence.enforcement?.may_sign === false ? mapped.action !== ACTION.TRADE : true,
      blockers: evidence.enforcement?.reason_codes || [],
    },
    evidence,
    mandate_hash,
    decision_hash,
    prompt_version: PROMPT_VERSION,
    timestamp_ms: Date.now(),
    llm_mode: llmMode,
  };

  await journal.append({
    kind: "decision",
    tick: decision.timestamp_ms,
    action: decision.action,
    reason: decision.reason,
    decision_hash,
    mandate_hash,
    prompt_version: PROMPT_VERSION,
    models,
    fitter_outcome: decision.fitter?.outcome || null,
    openrouter_spent_usd: state.openrouter_spent_usd,
    openrouter_requests_today: state.openrouter_requests_today,
    evidence_digest: createHash("sha256")
      .update(JSON.stringify(evidence), "utf8")
      .digest("hex")
      .slice(0, 32),
  });

  return decision;
}

function sanitizeLlm(block) {
  if (!block) return null;
  return {
    ok: block.ok ?? null,
    reason: block.reason || null,
    skipped: block.skipped || false,
    llm: block.llm
      ? {
          model: block.llm.model || null,
          at: block.llm.at || block.llm.finished_at || null,
          usage: block.llm.usage || null,
          cost_usd: block.llm.cost_usd ?? null,
        }
      : null,
    research: block.research || null,
    proposal: block.proposal
      ? {
          choice: block.proposal.choice,
          proposed_size_usdc_raw: block.proposal.proposed_size_usdc_raw,
          thesis: block.proposal.thesis || block.proposal.thesis_id,
        }
      : null,
    review: block.review
      ? {
          verdict: block.review.verdict,
          reasons: block.review.reasons || block.review.reason_codes,
        }
      : null,
  };
}

function summarizeFitter(fit) {
  if (!fit) return null;
  return {
    outcome: fit.outcome,
    reason_codes: fit.reason_codes || [],
    parameters_changed: fit.parameters_changed || [],
    fitted_size_raw:
      fit.fitted_proposal?.proposed_size_usdc_raw ||
      fit.fitted_proposal?.size_usdc_raw ||
      null,
    operation_id: fit.operation_id || null,
    fitter: fit.fitter || "deterministic_v1",
  };
}
