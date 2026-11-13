/**
 * Gate J — Market Researcher (LLM). Interprets sourced market data only.
 * Does not invent prices; does not propose trade sizes; does not sign.
 */
import { chatJson, getLlmConfig, getRoleModel } from "./llm.mjs";
import { REASON, nowIso } from "./types.mjs";

const SYSTEM = `You are NIO's Market Researcher for a hardware-governed trading agent.
You receive a market snapshot with NAMED sources and timestamps.
When market.live_1click.quotes[] is present, you MUST cite quote-level fields from those objects
(route_id, asset_in_id, asset_out_id, amount_in_raw, amount_out_raw, min_amount_out_raw,
amount_out_usd, fee_usd_estimate, freshness_ms, decimals). Do not reduce them to a mere "live_1click" label.
You MUST NOT invent or hallucinate prices, volumes, deposit addresses, or quotes not present in the input.
Never treat an LLM-invented deposit address as authoritative.
If a field is missing or stale, say so explicitly.
Return STRICT JSON:
{
  "summary": string,
  "pair": {"origin": string, "destination": string},
  "observed_prices": object,
  "source_names": string[],
  "data_quality": "good"|"fair"|"poor",
  "staleness": "fresh"|"aging"|"stale"|"unknown",
  "risks": string[],
  "opportunities": string[],
  "uncertainty": string,
  "notes": string
}
Do not recommend TRADE/NO_TRADE sizes. That is the Strategist's job.`;

export function normalizeResearch(parsed, meta = {}) {
  return {
    summary: String(parsed?.summary || ""),
    pair: {
      origin: String(parsed?.pair?.origin || meta.market?.pair?.origin || "USDC"),
      destination: String(
        parsed?.pair?.destination || meta.market?.pair?.destination || "wNEAR"
      ),
    },
    observed_prices:
      parsed?.observed_prices && typeof parsed.observed_prices === "object"
        ? parsed.observed_prices
        : {
            near_usd: meta.market?.near_usd ?? null,
            usdc_usd: meta.market?.usdc_usd ?? null,
          },
    source_names: Array.isArray(parsed?.source_names)
      ? parsed.source_names.map(String)
      : (meta.market?.sources || []).map((s) => s.name),
    data_quality: ["good", "fair", "poor"].includes(parsed?.data_quality)
      ? parsed.data_quality
      : "fair",
    staleness: ["fresh", "aging", "stale", "unknown"].includes(parsed?.staleness)
      ? parsed.staleness
      : meta.market?.stale
        ? "stale"
        : "unknown",
    risks: Array.isArray(parsed?.risks) ? parsed.risks.map(String) : [],
    opportunities: Array.isArray(parsed?.opportunities)
      ? parsed.opportunities.map(String)
      : [],
    uncertainty: String(parsed?.uncertainty || ""),
    notes: String(parsed?.notes || ""),
    model: meta.model || "unknown",
    requested_model: meta.requested_model || null,
    provider: meta.provider || "openrouter",
    timestamp: meta.timestamp || nowIso(),
    market_as_of: meta.market?.as_of || null,
  };
}

export async function runResearcherLlm({ market }) {
  const cfg = getLlmConfig();
  const user = JSON.stringify(
    {
      task: "Summarize sourced market data for USDC/wNEAR. Do not invent prices.",
      market,
      rules: [
        "Only cite values present in market.sources / market fields",
        "Flag stale or missing data",
        "No trade size recommendations",
      ],
    },
    null,
    2
  );
  try {
    const llm = await chatJson({
      role: "researcher",
      system: SYSTEM,
      user,
      temperature: 0.1,
    });
    const research = normalizeResearch(llm.parsed, {
      market,
      model: llm.model,
      requested_model: llm.requested_model,
      provider: llm.provider,
      timestamp: llm.timestamp,
    });
    return {
      ok: true,
      research,
      llm: {
        provider: llm.provider,
        role: "researcher",
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
      research: null,
      llm: {
        provider: "openrouter",
        role: "researcher",
        requested_model: getRoleModel("researcher"),
        model: getRoleModel("researcher"),
        configured: cfg.configured,
      },
    };
  }
}
