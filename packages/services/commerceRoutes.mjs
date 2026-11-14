/**
 * Read-only commerce API routes for mainnet-api-server.
 * Hire/payment actions are NOT exposed to anonymous browsers.
 */
import {
  createCommerceRuntime,
  commerceStatus,
  publicJobView,
  searchAgents,
} from "../commerce/index.mjs";

export function createCommerceHandlers({ dataDir, env = process.env }) {
  const runtime = createCommerceRuntime({ dataDir, env });

  return {
    runtime,
    status() {
      return commerceStatus(runtime, env);
    },
    async agents(url) {
      const q = url.searchParams.get("q") || "research";
      const category = url.searchParams.get("category") || "research";
      const limit = Math.min(20, Number(url.searchParams.get("limit") || 10));
      // Single catalog GET — avoid per-agent pricing fan-out on OCI
      const search = await searchAgents({ q, category, limit });
      const status = commerceStatus(runtime, env);
      const agents = (search.agents || []).map((a) => ({
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
        funding_paused: a.funding_paused,
        payable_with: a.payable_with || [],
      }));
      return {
        ok: search.ok,
        live: true,
        mock: false,
        agents_discovered: agents.length,
        agents,
        budget: status.budget,
        gates: status.gates,
        note: "Prices via discover-and-propose / fitter; this route is catalog-only for OCI",
      };
    },
    jobs() {
      return {
        ok: true,
        jobs: runtime.jobs.list().map(publicJobView),
        paid_count: runtime.jobs
          .list()
          .filter((j) => Number(j.paid_amount_usdc || 0) > 0 && !j.mock).length,
      };
    },
    job(id) {
      const j = runtime.jobs.get(id) || runtime.jobs.getByMarketJobId(id);
      if (!j) return { ok: false, reason: "not_found" };
      return { ok: true, job: publicJobView(j) };
    },
    async publicSearch(url) {
      const q = url.searchParams.get("q") || "";
      const category = url.searchParams.get("category") || "research";
      const limit = Math.min(50, Number(url.searchParams.get("limit") || 10));
      return searchAgents({ q, category, limit });
    },
  };
}

/**
 * @returns {boolean} true if handled
 */
export async function handleCommerceRoute(req, res, { path, url, json, mutating, handlers }) {
  if (!path.startsWith("/mainnet/commerce")) return false;

  // Block any commerce mutation from HTTP — internal/CLI only
  if (mutating) {
    json(req, res, 403, {
      ok: false,
      reason: "commerce_mutations_http_forbidden",
      note: "Hire/payment are internal and separately authorized — not via public API",
    });
    return true;
  }

  if (req.method === "GET" && path === "/mainnet/commerce/status") {
    json(req, res, 200, handlers.status());
    return true;
  }
  if (req.method === "GET" && path === "/mainnet/commerce/agents") {
    json(req, res, 200, await handlers.agents(url));
    return true;
  }
  if (req.method === "GET" && path === "/mainnet/commerce/jobs") {
    json(req, res, 200, handlers.jobs());
    return true;
  }
  if (req.method === "GET" && path.startsWith("/mainnet/commerce/jobs/")) {
    const id = decodeURIComponent(path.slice("/mainnet/commerce/jobs/".length));
    const out = handlers.job(id);
    json(req, res, out.ok ? 200 : 404, out);
    return true;
  }

  json(req, res, 404, { ok: false, reason: "commerce_route_not_found", path });
  return true;
}
