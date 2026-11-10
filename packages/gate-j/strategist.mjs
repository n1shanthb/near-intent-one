/**
 * Gate J — AI Strategist. Proposes only; never signs or edits policy.
 */
import { chatJson, getLlmConfig, getRoleModel } from "./llm.mjs";
import { nowIso, usdcRawFromUsd, REASON } from "./types.mjs";

const SYSTEM = `You are NIO's AI Strategist for a hardware-governed trading agent on NEAR testnet.
You propose trades as STRICT JSON only. You never sign transactions or change policy.
Mandate constraints are immutable — do not invent permissions.
You receive Researcher output plus sourced market data — do not invent prices.
You do NOT write the Risk Critic's verdict.
Output JSON keys:
choice ("TRADE"|"NO_TRADE"),
pair {origin,destination},
direction,
proposed_size_usd (number),
min_viable_size_usd (number),
thesis (string),
thesis_id (string),
expected_benefit {edge_bps, horizon, notes},
estimated_costs {fee_bps, price_impact_bps, notes},
max_slippage_bps (number),
invariants (string[]),
evidence (array of {source,note}),
uncertainty (string),
network (string).
Prefer USDC->wNEAR on sepolia+intents when trading. Be conservative.
Reply with a single JSON object only — no markdown fences, no prose.`;

function normalizePair(pair) {
  if (pair && typeof pair === "object") {
    return {
      origin: String(pair.origin || "USDC"),
      destination: String(pair.destination || "wNEAR"),
    };
  }
  if (typeof pair === "string" && pair.includes("/")) {
    const [origin, destination] = pair.split("/").map((s) => s.trim());
    return { origin: origin || "USDC", destination: destination || "wNEAR" };
  }
  return { origin: "USDC", destination: "wNEAR" };
}

function normalizeProposal(parsed, { market, model, timestamp }) {
  const choice = parsed.choice === "TRADE" ? "TRADE" : "NO_TRADE";
  const proposedUsd = Number(parsed.proposed_size_usd ?? parsed.proposed_size ?? 0);
  const minUsd = Number(parsed.min_viable_size_usd ?? parsed.min_viable_size ?? 0);
  if (choice === "TRADE" && !(proposedUsd > 0 && minUsd > 0 && minUsd <= proposedUsd)) {
    return {
      ok: false,
      reason: REASON.MALFORMED_PROPOSAL,
      detail: "invalid sizes",
      raw: parsed,
    };
  }
  return {
    ok: true,
    proposal: {
      choice,
      pair: normalizePair(parsed.pair),
      direction: String(parsed.direction || "SELL_ORIGIN"),
      proposed_size_usdc_raw: usdcRawFromUsd(proposedUsd || 0),
      min_viable_size_usdc_raw: usdcRawFromUsd(minUsd || 0),
      thesis: String(parsed.thesis || ""),
      thesis_id: String(parsed.thesis_id || "usdc-to-wnear-mandate-fit-v1"),
      expected_benefit: parsed.expected_benefit || { edge_bps: 0 },
      estimated_costs: parsed.estimated_costs || { fee_bps: 0, price_impact_bps: 0 },
      max_slippage_bps: Number(parsed.max_slippage_bps ?? 50),
      invariants: Array.isArray(parsed.invariants)
        ? parsed.invariants
        : ["pair", "direction", "thesis_id"],
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
      uncertainty: String(parsed.uncertainty || ""),
      network: String(parsed.network || market?.network || "sepolia"),
      selected_quote: parsed.selected_quote || null,
      quotes: Array.isArray(parsed.quotes) ? parsed.quotes : undefined,
      model,
      timestamp,
      market_as_of: market?.as_of || null,
    },
  };
}

/**
 * Real LLM proposal via OpenRouter (OPENROUTER_API_KEY). Fail closed — no fixture masquerade.
 */
export async function runStrategistLlm({
  market,
  mandate,
  balances,
  forecast = null,
  research = null,
}) {
  const cfg = getLlmConfig();
  const user = JSON.stringify(
    {
      task: "Propose TRADE or NO_TRADE for this portfolio under the immutable mandate.",
      market,
      research,
      mandate_summary: {
        portfolio_id: mandate.portfolio_id,
        allowed_assets: mandate.allowed_assets,
        allowed_networks: mandate.allowed_networks,
        per_trade_limit_usdc_raw: mandate.per_trade_limit_usdc_raw,
        revoked: mandate.revoked,
        paused: mandate.paused,
      },
      balances,
      forecast,
      note: "Do not exceed mandate. Explain uncertainty. Cite research/market sources only.",
    },
    null,
    2
  );
  try {
    const llm = await chatJson({
      role: "strategist",
      system: SYSTEM,
      user,
      temperature: 0.2,
    });
    const norm = normalizeProposal(llm.parsed, {
      market,
      model: llm.model,
      timestamp: llm.timestamp,
    });
    if (!norm.ok) {
      return {
        ok: false,
        reason: norm.reason,
        llm,
        proposal: null,
      };
    }
    return {
      ok: true,
      proposal: {
        ...norm.proposal,
        requested_model: llm.requested_model,
        provider: llm.provider,
        request_id: llm.request_id,
      },
      llm: {
        provider: llm.provider,
        role: "strategist",
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
    return {
      ok: false,
      reason: e.code || REASON.LLM_TIMEOUT,
      error: String(e.message || e).slice(0, 300),
      proposal: null,
      llm: {
        provider: "openrouter",
        role: "strategist",
        requested_model: getRoleModel("strategist"),
        model: getRoleModel("strategist"),
        configured: cfg.configured,
      },
    };
  }
}

/**
 * Fixture strategist for reproducible demos (not LLM — labeled as such).
 */
export function runStrategistFixture(fixtureProposal) {
  const timestamp = nowIso();
  const norm = normalizeProposal(
    {
      ...fixtureProposal,
      proposed_size_usd:
        fixtureProposal.proposed_size_usd ??
        Number(fixtureProposal.proposed_size_usdc_raw || 0) / 1e6,
      min_viable_size_usd:
        fixtureProposal.min_viable_size_usd ??
        Number(fixtureProposal.min_viable_size_usdc_raw || 0) / 1e6,
    },
    {
      market: fixtureProposal.market || null,
      model: "fixture:strategist-v1",
      timestamp,
    }
  );
  return {
    ok: norm.ok,
    reason: norm.reason,
    proposal: norm.proposal,
    llm: {
      provider: "fixture",
      model: "fixture:strategist-v1",
      note: "Deterministic fixture — not an LLM call",
      timestamp,
    },
  };
}
