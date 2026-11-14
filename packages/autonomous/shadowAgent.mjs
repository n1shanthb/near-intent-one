/**
 * Shadow/DRY_RUN Agent Loop
 * Adapts Gate J roles: Researcher → Strategist → Fitter → Critic → DeterministicGuard → Decision
 * 
 * Actions: HOLD, WAIT, BUY_DATA, TRADE
 * NO signing, NO broadcasting.
 * Schema-validated decisions with journal entries.
 */

import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";

export const MODE = Object.freeze({
  SHADOW: "SHADOW",
  DRY_RUN: "DRY_RUN",
});

export const ACTION = Object.freeze({
  HOLD: "HOLD",
  WAIT: "WAIT",
  BUY_DATA: "BUY_DATA",
  TRADE: "TRADE",
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
});

/**
 * Mock LLM call for testing when OPENROUTER_API_KEY not present.
 */
function mockLlmCall(role, input) {
  if (role === "researcher") {
    return {
      summary: "Mock research: NEAR/USDC market stable",
      pair: { origin: "USDC", destination: "wNEAR" },
      observed_prices: { near_usd: 5.0, usdc_usd: 1.0 },
      source_names: ["mock_source"],
      data_quality: "fair",
      staleness: "fresh",
      risks: [],
      opportunities: [],
      uncertainty: "low",
      notes: "Mock LLM response",
    };
  }
  if (role === "strategist") {
    return {
      action: ACTION.HOLD,
      reasoning: "Mock strategist: insufficient conviction",
      confidence: 0.3,
      proposed_size_usdc_raw: "0",
    };
  }
  if (role === "critic") {
    return {
      verdict: "NO_TRADE",
      reasoning: "Mock critic: no trade needed",
      confidence: 0.8,
    };
  }
  return { error: "unknown_role" };
}

/**
 * Call LLM (or mock if key not present).
 */
async function callLlm(role, systemPrompt, userInput, opts = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    return mockLlmCall(role, userInput);
  }

  // Real OpenRouter call would go here
  // For now, return mock (actual implementation requires HTTP client)
  return mockLlmCall(role, userInput);
}

/**
 * Research phase: interpret market data.
 */
async function runResearch(market, opts = {}) {
  const system = `You are NIO's Market Researcher. Interpret provided market data only. Do not invent prices.`;
  const user = JSON.stringify(market);
  const response = await callLlm("researcher", system, user, opts);
  return normalizeResearch(response, { market });
}

function normalizeResearch(parsed, meta) {
  return {
    summary: String(parsed?.summary || ""),
    pair: parsed?.pair || { origin: "USDC", destination: "wNEAR" },
    observed_prices: parsed?.observed_prices || {},
    source_names: parsed?.source_names || [],
    data_quality: parsed?.data_quality || "unknown",
    staleness: parsed?.staleness || "unknown",
    risks: parsed?.risks || [],
    opportunities: parsed?.opportunities || [],
    uncertainty: parsed?.uncertainty || "high",
    notes: parsed?.notes || "",
  };
}

/**
 * Strategist phase: propose action.
 */
async function runStrategist(research, mandate, opts = {}) {
  const system = `You are NIO's Trading Strategist. Propose action based on research and mandate limits.`;
  const user = JSON.stringify({ research, mandate });
  const response = await callLlm("strategist", system, user, opts);
  return normalizeStrategy(response);
}

function normalizeStrategy(parsed) {
  return {
    action: parsed?.action || ACTION.HOLD,
    reasoning: parsed?.reasoning || "",
    confidence: Number(parsed?.confidence ?? 0),
    proposed_size_usdc_raw: String(parsed?.proposed_size_usdc_raw || "0"),
  };
}

/**
 * Critic phase: veto check.
 */
async function runCritic(strategy, research, opts = {}) {
  const system = `You are NIO's Trading Critic. Veto if risks outweigh opportunity.`;
  const user = JSON.stringify({ strategy, research });
  const response = await callLlm("critic", system, user, opts);
  return normalizeCritic(response);
}

function normalizeCritic(parsed) {
  return {
    verdict: parsed?.verdict || "NO_TRADE",
    reasoning: parsed?.reasoning || "",
    confidence: Number(parsed?.confidence ?? 0),
  };
}

/**
 * Deterministic guard: schema validation, budget checks.
 */
function runDeterministicGuard(strategy, mandate, state) {
  const blockers = [];

  // Budget check
  const proposed = BigInt(strategy.proposed_size_usdc_raw || "0");
  const max_trade = BigInt(mandate.max_trade_raw || "0");
  if (proposed > max_trade) {
    blockers.push("proposed_exceeds_max_trade");
  }

  // Daily turnover
  const spent_today = BigInt(state.spent_today_raw || "0");
  const daily_limit = BigInt(mandate.daily_turnover_budget_raw || "0");
  if (spent_today + proposed > daily_limit) {
    blockers.push("daily_turnover_exceeded");
  }

  // Pending exposure
  const pending = BigInt(state.pending_exposure_raw || "0");
  const max_pending = BigInt(mandate.max_pending_exposure_raw || "0");
  if (pending + proposed > max_pending) {
    blockers.push("pending_exposure_exceeded");
  }

  return {
    ok: blockers.length === 0,
    blockers,
  };
}

/**
 * Create shadow agent.
 */
export function createShadowAgent({ mandate, journal, mode = MODE.SHADOW }) {
  assert.equal(mode, MODE.SHADOW, "only_shadow_mode_supported");
  assert(mandate, "mandate_required");
  assert(journal, "journal_required");

  const state = {
    spent_today_raw: "0",
    pending_exposure_raw: "0",
    openrouter_spent_usd: 0,
    openrouter_requests_today: 0,
  };

  return {
    mode,
    mandate,
    journal,
    state,
  };
}

/**
 * Run one shadow tick.
 * 
 * @param {object} agent - created by createShadowAgent
 * @param {object} market - market snapshot
 * @returns {Promise<object>} decision
 */
export async function runShadowTick(agent, market) {
  const { mandate, journal, state } = agent;

  // Check OpenRouter spend cap
  if (state.openrouter_spent_usd >= Number(mandate.openrouter_daily_usd_micros || 0) / 1_000_000) {
    journal.append({
      tick: Date.now(),
      action: ACTION.HOLD,
      reason: "openrouter_spend_cap",
      decision_hash: "N/A",
    });
    return { action: ACTION.HOLD, reason: "openrouter_spend_cap" };
  }

  // Check request cap
  if (state.openrouter_requests_today >= mandate.openrouter_max_requests_per_day) {
    journal.append({
      tick: Date.now(),
      action: ACTION.HOLD,
      reason: "openrouter_request_cap",
      decision_hash: "N/A",
    });
    return { action: ACTION.HOLD, reason: "openrouter_request_cap" };
  }

  try {
    // Research
    const research = await runResearch(market);
    state.openrouter_requests_today += 1;

    // Strategist
    const strategy = await runStrategist(research, mandate);
    state.openrouter_requests_today += 1;

    // Critic
    const critic = await runCritic(strategy, research);
    state.openrouter_requests_today += 1;

    // Deterministic guard
    const guard = runDeterministicGuard(strategy, mandate, state);

    // Decision
    let action = ACTION.HOLD;
    let reason = REASON.NO_OPPORTUNITY;

    if (critic.verdict !== "TRADE" && critic.verdict !== "YES") {
      reason = REASON.CRITIC_VETO;
    } else if (!guard.ok) {
      reason = REASON.GUARD_BLOCKED;
      action = ACTION.HOLD;
    } else if (strategy.action === ACTION.TRADE) {
      action = ACTION.TRADE;
      reason = REASON.OPPORTUNITY_FOUND;
    } else if (strategy.action === ACTION.BUY_DATA) {
      action = ACTION.BUY_DATA;
      reason = REASON.INSUFFICIENT_DATA;
    }

    const decision = {
      action,
      reason,
      strategy,
      research,
      critic,
      guard,
      timestamp_ms: Date.now(),
    };

    const decision_hash = hashDecision(decision);
    journal.append({
      tick: decision.timestamp_ms,
      action,
      reason,
      decision_hash,
    });

    return decision;
  } catch (err) {
    journal.append({
      tick: Date.now(),
      action: ACTION.HOLD,
      reason: "error",
      error: err.message,
      decision_hash: "N/A",
    });
    throw err;
  }
}

function hashDecision(decision) {
  const canonical = JSON.stringify(decision, Object.keys(decision).sort());
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
}
