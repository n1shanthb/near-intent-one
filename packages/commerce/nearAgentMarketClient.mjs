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

function authHeaders(token, cookie) {
  const h = {
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": "nio-commerce/1.0",
  };
  if (token) h.authorization = `Bearer ${token}`;
  if (cookie) h.cookie = cookie;
  return h;
}

function extractSetCookies(res) {
  if (typeof res.headers.getSetCookie === "function") {
    return res.headers.getSetCookie();
  }
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

/** Pull `name=value` pairs from Set-Cookie headers (hire_draft cookie flow). */
export function cookieHeaderFromSetCookie(setCookies) {
  const pairs = [];
  for (const raw of setCookies || []) {
    const first = String(raw).split(";")[0]?.trim();
    if (first && first.includes("=")) pairs.push(first);
  }
  return pairs.length ? pairs.join("; ") : null;
}

async function marketFetch(
  path,
  { method = "GET", token, cookie, body, base = MARKET_BASE } = {}
) {
  const url = path.startsWith("http") ? path : `${base.replace(/\/$/, "")}${path}`;
  let res;
  let text;
  try {
    res = await fetch(url, {
      method,
      headers: authHeaders(token, cookie),
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
  return {
    ok: res.ok,
    status: res.status,
    json,
    text,
    url,
    set_cookies: extractSetCookies(res),
    cookie: cookieHeaderFromSetCookie(extractSetCookies(res)),
  };
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

/**
 * Visitor hire-draft (unauthenticated). Does NOT fund or hire.
 * Official API keys the draft with Set-Cookie `hire_draft=…` (7-day TTL).
 */
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
    hire_draft_id: r.json?.hireDraftId || null,
    cookie: r.cookie,
    funded: false,
    hired: false,
    live: true,
    mock: false,
    note: "Draft only — buyer must claim/approve/fund on marketplace; no payment yet",
  };
}

/** Discard visitor draft using the hire_draft cookie from createHireDraft. */
export async function discardHireDraft({ cookie, base } = {}) {
  if (!cookie) {
    return { ok: false, reason: "missing_hire_draft_cookie" };
  }
  const r = await marketFetch(`/v1/hire-draft`, {
    method: "DELETE",
    cookie,
    base,
  });
  return {
    ok: r.status === 204 || r.ok,
    status: r.status,
    detail: r.json,
  };
}

/**
 * Claim visitor hire-draft into an authenticated job draft.
 * Requires human buyer session/OAuth — never uses aat_ agent tokens.
 * Does NOT fund escrow.
 */
export async function claimHireDraft({ token, cookie, base, env = process.env } = {}) {
  const t = token || getBuyerToken(env);
  if (!t) return { ok: false, reason: "missing_buyer_token", funded: false };
  if (!cookie) return { ok: false, reason: "missing_hire_draft_cookie", funded: false };
  const r = await marketFetch(`/v1/hire-draft/claim`, {
    method: "POST",
    token: t,
    cookie,
    base,
  });
  if (!r.ok) {
    return {
      ok: false,
      reason: r.status === 401 ? "unauthorized" : "claim_failed",
      status: r.status,
      detail: r.json,
      funded: false,
    };
  }
  return {
    ok: true,
    claimed: r.json,
    funded: false,
    hired: false,
    live: true,
    mock: false,
    note: "Claimed to job draft only — payment still requires marketplace approval/balance",
  };
}

/**
 * Authenticated-readiness probe. Never enables payments or creates a paid hire.
 */
export async function checkMarketplaceAccountReadiness({
  env = process.env,
  probeAgentId = null,
  brief = "NIO commerce readiness probe — discard immediately. No payment.",
  base,
} = {}) {
  const token = getBuyerToken(env);
  const me = await marketFetch(`/v1/me`, { token: token || undefined, base });
  const balance = await marketFetch(`/v1/wallet/balance`, {
    token: token || undefined,
    base,
  });

  let hireDraft = null;
  let discarded = null;
  if (probeAgentId) {
    hireDraft = await createHireDraft(probeAgentId, { brief, base });
    if (hireDraft.ok && hireDraft.cookie) {
      discarded = await discardHireDraft({ cookie: hireDraft.cookie, base });
    }
  }

  const buyer_session_ok = me.ok === true && me.status === 200;
  const wallet_readable = balance.ok === true && balance.status === 200;
  const usdc =
    balance.json?.usdc != null
      ? Number(balance.json.usdc)
      : balance.json?.USDC != null
        ? Number(balance.json.USDC)
        : null;

  return {
    ok: true,
    live: true,
    mock: false,
    paid: false,
    buyer_token_present: Boolean(token),
    buyer_session_ok,
    wallet_readable,
    wallet_usdc: Number.isFinite(usdc) ? usdc : null,
    me_status: me.status,
    balance_status: balance.status,
    hire_draft_probe: hireDraft
      ? {
          ok: hireDraft.ok,
          hire_draft_id: hireDraft.hire_draft_id,
          agent: hireDraft.draft?.agentHandle || null,
          discarded: discarded?.ok === true,
          funded: false,
        }
      : null,
    payments_enabled: paymentsEnabled(env),
    auth_path: {
      web: "https://market.near.ai — sign in as a human buyer",
      mcp: "https://market.near.ai/mcp — OAuth as the person (not an aat_ agent token)",
      skill: "https://market.near.ai/skill/mcp-buyer/SKILL.md",
      note: "aat_ worker tokens cannot hire. Buyer token must be a human OAuth/session credential stored server-side as NIO_COMMERCE_BUYER_TOKEN.",
    },
    next: [
      "Create/sign in to marketplace human account",
      "Fund marketplace USDC balance ≥ quoted hire price (escrow rail)",
      "Authorize MCP OAuth as yourself OR export a server-side buyer session token",
      "Set NIO_COMMERCE_BUYER_TOKEN (never VITE_*/Ledger/MPC/ops keys)",
      "Re-run account readiness until buyer_session_ok + wallet_readable",
      "Separate explicit approval to set NIO_COMMERCE_PAYMENTS_ENABLED=1 for one hire",
    ],
    marketplace_account_ready: buyer_session_ok && wallet_readable,
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
