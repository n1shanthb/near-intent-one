/**
 * API authorization helpers (Gate I).
 * Service API key ≠ owner session. Personal mutations need both when configured.
 */

export const DEMO_PORTFOLIO_IDS = new Set(["i-a-a4e7", "i-b-a4e7"]);

/**
 * Whether open-dev (no API key) is permitted.
 * Production/public bind addresses must fail closed.
 */
export function allowOpenDevMode(env = process.env, { remoteAddress } = {}) {
  if (env.GATE_I_ALLOW_OPEN_DEV === "1") {
    const host = String(env.GATE_I_HOST || "0.0.0.0").trim();
    const localHost =
      host === "127.0.0.1" ||
      host === "localhost" ||
      host === "::1";
    const peer = String(remoteAddress || "");
    const localPeer =
      !peer ||
      peer === "127.0.0.1" ||
      peer === "::1" ||
      peer === ":ffff:127.0.0.1" ||
      peer.endsWith("127.0.0.1");
    if (localHost && localPeer) return true;
    if (env.GATE_I_ENV === "test" || env.NODE_ENV === "test") return true;
    return false;
  }
  if (env.GATE_I_ENV === "test" || env.NODE_ENV === "test") {
    // Tests may omit key only when explicitly in test env.
    return env.GATE_I_ALLOW_OPEN_DEV === "1";
  }
  return false;
}

/**
 * Service-level mutation auth.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function authorizeService(req, { mutating, apiKey, env = process.env } = {}) {
  if (!mutating) return { ok: true };
  const key = apiKey != null ? apiKey : env.GATE_I_API_KEY || "";
  if (!key) {
    if (allowOpenDevMode(env, { remoteAddress: req?.socket?.remoteAddress })) {
      return { ok: true, mode: "open_dev_localhost_only" };
    }
    return { ok: false, reason: "api_key_required" };
  }
  const hdr =
    req?.headers?.["x-api-key"] ||
    (String(req?.headers?.authorization || "").startsWith("Bearer ")
      ? String(req.headers.authorization).slice(7)
      : "");
  if (hdr !== key) return { ok: false, reason: "unauthorized" };
  return { ok: true, mode: "api_key" };
}

/**
 * Personal portfolio mutation: verified owner session must match store owner.
 * Rejects demo spoofing for agent control.
 */
export function authorizePortfolioOwner({
  portfolioId,
  portfolio,
  session,
  requireReady = false,
} = {}) {
  if (!portfolioId || typeof portfolioId !== "string") {
    return { ok: false, reason: "invalid_portfolio_id" };
  }
  if (portfolioId.includes("..") || portfolioId.includes("/") || portfolioId.includes("\\")) {
    return { ok: false, reason: "portfolio_id_spoof_rejected" };
  }
  if (!session?.ok) {
    return {
      ok: false,
      reason: session?.reason || "owner_session_required",
    };
  }
  if (Date.parse(session.expires_at || 0) < Date.now()) {
    return { ok: false, reason: "session_expired" };
  }
  if (!portfolio) {
    return { ok: false, reason: "unknown_portfolio" };
  }
  if (String(portfolio.portfolio_id || portfolioId) !== String(portfolioId)) {
    return { ok: false, reason: "portfolio_id_mismatch" };
  }
  const owner = String(portfolio.owner_account || "");
  if (!owner || owner !== String(session.account_id)) {
    return { ok: false, reason: "owner_mismatch" };
  }
  if (requireReady && portfolio.deploy_status && portfolio.deploy_status !== "ready") {
    return { ok: false, reason: "portfolio_not_ready" };
  }
  if (String(portfolio.policy_contract || "").startsWith("nio-c-")) {
    return { ok: false, reason: "demo_ledger_portfolio_forbidden" };
  }
  return {
    ok: true,
    account_id: session.account_id,
    session_id: session.session_id,
    portfolio_id: portfolioId,
  };
}

/** Public BFF must never proxy these paths. */
export const PRIVATE_AGENT_PATH_RE =
  /^\/portfolios\/[^/]+\/agent(\/(start|stop))?$/;

export function isPrivateAgentPath(path) {
  const p = String(path || "").replace(/^\/v1/, "") || "/";
  return PRIVATE_AGENT_PATH_RE.test(p);
}

export function isDemoPortfolioId(id) {
  return DEMO_PORTFOLIO_IDS.has(String(id));
}
