/**
 * Real NEAR Agent Market HTTP client (market.near.ai).
 * Public discovery works without auth. Hire/payment mutations require a buyer
 * bearer token and explicit NIO_COMMERCE_PAYMENTS_ENABLED=1.
 *
 * Official refs: https://market.near.ai/llms.txt · /openapi.json · /skill/mcp-buyer/SKILL.md
 * NEVER treat packages/autonomous/agentMarket.mjs mock results as live commerce.
 */
import { createHash } from "node:crypto";

export const MARKET_BASE =
  process.env.NIO_AGENT_MARKET_BASE || "https://market.near.ai";

export class MarketClientError extends Error {
  constructor(code, message, detail = {}) {
    super(message || code);
    this.code = code;
    this.detail = detail;
    this.name = "MarketClientError";
  }
}

function authHeaders(token) {
  const h = {
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": "nio-commerce/1.0",
  };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

async function marketFetch(path, { method = "GET", token, body, base = MARKET_BASE } = {}) {
  const url = path.startsWith("http") ? path : `${base.replace(/\/$/, "")}${path}`;
  let res;
  let text;
  try {
    res = await fetch(url, {
      method,
      headers: authHeaders(token),
      body: body != null ? JSON.stringify(body) : undefined,
    });
    text = await res.text();
  } catch (e) {
    throw new MarketClientError("network_error", String(e.message || e), {
      url,
    });
  }
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { ok: res.ok, status: res.status, json, text, url };
}

export function getBuyerToken(env = process.env) {
  return (
    String(env.NIO_COMMERCE_BUYER_TOKEN || env.NEAR_MARKET_BUYER_TOKEN || "").trim() ||
    null
  );
}

export function paymentsEnabled(env = process.env) {
  return env.NIO_COMMERCE_PAYMENTS_ENABLED === "1";
}

/** Public catalog search — no auth. */
export async function searchAgents({
  q = "",
  category = "research",
  sort = "delivered",
  limit = 20,
  offset = 0,
  verification,
  proven,
  base,
} = {}) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (category) params.set("category", category);
  if (sort) params.set("sort", sort);
  if (limit != null) params.set("limit", String(limit));
  if (offset != null) params.set("offset", String(offset));
  if (verification) params.set("verification", verification);
  if (proven) params.set("proven", String(proven));
  const r = await marketFetch(`/v1/agents?${params}`, { base });
  if (!r.ok) {
    return {
      ok: false,
      reason: r.status === 401 ? "unauthorized" : "search_failed",
      status: r.status,
      detail: r.json,
    };
  }
  const agents = Array.isArray(r.json?.agents) ? r.json.agents : [];
  return {
    ok: true,
    agents,
    count: agents.length,
    api: MARKET_BASE,
    live: true,
    mock: false,
  };
}

export async function getAgent(idOrHandle, { base } = {}) {
  const id = encodeURIComponent(String(idOrHandle || "").trim());
  if (!id) throw new MarketClientError("missing_agent_id");
  const r = await marketFetch(`/v1/agents/${id}`, { base });
  if (!r.ok) {
    return {
      ok: false,
      reason: r.status === 404 ? "agent_not_found" : "get_agent_failed",
      status: r.status,
      detail: r.json,
    };
  }
  return { ok: true, agent: r.json, live: true, mock: false };
}

export async function listPricingPlans(agentId, { base } = {}) {
  const id = encodeURIComponent(String(agentId || "").trim());
  const r = await marketFetch(`/v1/agents/${id}/pricing-plans`, { base });
  if (!r.ok) {
    return {
      ok: false,
      reason: "pricing_failed",
      status: r.status,
      detail: r.json,
    };
  }
  const plans = Array.isArray(r.json) ? r.json : r.json?.plans || [];
  return { ok: true, plans, live: true, mock: false };
}

export async function getAgentReputation(agentId, { base } = {}) {
  const id = encodeURIComponent(String(agentId || "").trim());
  const r = await marketFetch(`/v1/agents/${id}/reputation`, { base });
  if (!r.ok) {
    return { ok: false, reason: "reputation_unavailable", status: r.status };
  }
  return { ok: true, reputation: r.json, live: true };
}

/**
 * Enrich agents with default pricing (sequential to stay gentle on OCI).
 */
export async function discoverAgentsWithPricing(opts = {}) {
  const search = await searchAgents(opts);
  if (!search.ok) return search;
  const enriched = [];
  for (const a of search.agents) {
    // eslint-disable-next-line no-await-in-loop
    const pricing = await listPricingPlans(a.agent_id, { base: opts.base });
    const plans = pricing.ok ? pricing.plans : [];
    const def = plans.find((p) => p.is_default) || plans[0] || null;
    enriched.push({
      agent_id: a.agent_id,
      handle: a.handle,
      name: a.name,
      description: a.description,
      category: a.category,
      tags: a.tags || [],
      listing_url: `https://market.near.ai/agents/${a.handle}`,
      listing_status: a.listing_status,
      delivered_jobs: a.delivered_jobs,
      success_rate: a.success_rate,
      available_now: a.available_now,
      availability: a.availability,
      funding_paused: a.funding_paused,
      payable_with: a.payable_with || [],
      builder: a.builder || null,
      price_amount: def?.price_amount ?? null,
      pricing_plan_id: def?.pricing_plan_id ?? null,
      pricing_model: def?.model ?? null,
      price_currency: "USDC",
      sla_seconds: def?.sla_seconds ?? a.sla_seconds ?? null,
    });
  }
  return {
    ok: true,
    agents: enriched,
    count: enriched.length,
    live: true,
    mock: false,
    queried_at: new Date().toISOString(),
  };
}

/** Visitor hire-draft (unauthenticated). Does NOT fund or hire. */
export async function createHireDraft(agentId, { brief, acceptanceWindowDays = 3, base } = {}) {
  if (!brief || String(brief).trim().length < 8) {
    return { ok: false, reason: "brief_too_short" };
  }
  const id = encodeURIComponent(String(agentId).trim());
  const r = await marketFetch(`/v1/agents/${id}/hire-draft`, {
    method: "POST",
    body: {
      brief: String(brief).slice(0, 10000),
      acceptanceWindowDays,
    },
    base,
  });
  if (!r.ok) {
    return {
      ok: false,
      reason: "hire_draft_failed",
      status: r.status,
      detail: r.json,
    };
  }
  return {
    ok: true,
    draft: r.json,
    funded: false,
    hired: false,
    live: true,
    mock: false,
    note: "Draft only — buyer must approve/fund on marketplace; no payment yet",
  };
}

export async function discardHireDraft(hireDraftId, { base } = {}) {
  const r = await marketFetch(
    `/v1/hire-draft?hireDraftId=${encodeURIComponent(hireDraftId)}`,
    { method: "DELETE", base }
  );
  return {
    ok: r.status === 204 || r.ok,
    status: r.status,
    detail: r.json,
  };
}

/**
 * Authenticated buyer job list. Requires bearer token.
 */
export async function listMyJobs({ token, state, limit = 20, base, env = process.env } = {}) {
  const t = token || getBuyerToken(env);
  if (!t) return { ok: false, reason: "missing_buyer_token", jobs: [] };
  const params = new URLSearchParams({ limit: String(limit) });
  if (state) params.set("state", state);
  const r = await marketFetch(`/v1/me/jobs?${params}`, { token: t, base });
  if (!r.ok) {
    return {
      ok: false,
      reason: r.status === 401 ? "unauthorized" : "list_jobs_failed",
      status: r.status,
      detail: r.json,
      jobs: [],
    };
  }
  const jobs = Array.isArray(r.json?.jobs) ? r.json.jobs : Array.isArray(r.json) ? r.json : [];
  return { ok: true, jobs, live: true, mock: false };
}

export async function getJob(jobId, { token, base, env = process.env } = {}) {
  const t = token || getBuyerToken(env);
  const r = await marketFetch(`/v1/jobs/${encodeURIComponent(jobId)}`, {
    token: t || undefined,
    base,
  });
  if (!r.ok) {
    return {
      ok: false,
      reason: r.status === 404 ? "job_not_found" : "get_job_failed",
      status: r.status,
      detail: r.json,
    };
  }
  return { ok: true, job: r.json, live: true, mock: false };
}

/**
 * Paid hire — hard-gated. Never called from public HTTP routes.
 * Official path: MCP prepare_job / job-draft hire after human approval page.
 * This REST helper refuses unless payments explicitly enabled + token present.
 */
export async function attemptAuthenticatedHire(agentId, brief, opts = {}) {
  const env = opts.env || process.env;
  if (!paymentsEnabled(env)) {
    return {
      ok: false,
      submitted: false,
      reason: "commerce_payments_disabled",
      note: "Set NIO_COMMERCE_PAYMENTS_ENABLED=1 only after explicit purchase authorization",
    };
  }
  const token = opts.token || getBuyerToken(env);
  if (!token) {
    return { ok: false, submitted: false, reason: "missing_buyer_token" };
  }
  // Prefer creating an authenticated job draft if the deployment supports it.
  const draft = await marketFetch(`/v1/me/job-drafts`, {
    method: "POST",
    token,
    body: {
      payload: {
        worker_agent_id: agentId,
        title: opts.title || "NIO commerce research hire",
        description: brief,
        client_request_id:
          opts.client_request_id ||
          createHash("sha256").update(`${agentId}:${brief}:${Date.now()}`).digest("hex").slice(0, 32),
      },
    },
    base: opts.base,
  });
  if (!draft.ok) {
    return {
      ok: false,
      submitted: false,
      reason: "job_draft_create_failed",
      status: draft.status,
      detail: draft.json,
      note: "Hire still requires marketplace approval URL / balance funding — not completed",
    };
  }
  return {
    ok: true,
    submitted: false,
    draft: draft.json,
    reason: "draft_created_awaiting_human_approval",
    note: "Financial hire not finalized in NIO — complete approval on marketplace UI",
  };
}

export function hashBrief(brief) {
  return createHash("sha256").update(String(brief || ""), "utf8").digest("hex");
}

export function parseUsdcAmount(priceAmount) {
  const n = Number(priceAmount);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}
