/**
 * Production Vercel BFF — allowlisted proxy to OCI NIO API.
 * Mounted at /api (vercel.json rewrites /api/* → /api).
 * Credentials stay server-side (GATE_I_API_KEY). Never trust browser auth headers.
 *
 * Live AI uses POST /gate-j/demo-decide only (OCI quotas + hard dry-run).
 * Fixtures use POST /gate-j/decide with use_llm=false.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const DEMO_PORTFOLIOS = new Set(["i-a-a4e7", "i-b-a4e7"]);
const MAX_BODY = 64 * 1024;
/** Keep under Vercel maxDuration; OCI demo timeout is 90s — align via maxDuration. */
const TIMEOUT_MS = 95_000;
const MAX_RESPONSE = 512 * 1024;
const DEMO_COOKIE = "nio_demo_cid";

const ALLOWED_EXACT = new Set([
  "GET /health",
  "GET /gate-j/health",
  "GET /gate-j/scenarios",
  "GET /gate-j/decisions",
  "GET /gate-j/market",
  "GET /gate-j/demo-status",
  "POST /gate-j/decide",
  "POST /gate-j/demo-decide",
  "POST /gate-j/fit",
]);

function apiBase(): string {
  const raw = process.env.NIO_API_BASE || process.env.GATE_I_UPSTREAM || "";
  return raw.replace(/\/$/, "");
}

function apiKey(): string {
  return (process.env.GATE_I_API_KEY || "").trim();
}

function liveAiEnabled(): boolean {
  return process.env.NIO_PUBLIC_LIVE_AI === "true";
}

function cookieSecret(): string {
  return apiKey() || "nio-demo-cookie-dev-only";
}

function signClientId(id: string): string {
  const mac = createHmac("sha256", cookieSecret()).update(id).digest("hex").slice(0, 32);
  return `${id}.${mac}`;
}

function verifyClientToken(token: string): string | null {
  const i = token.lastIndexOf(".");
  if (i <= 0) return null;
  const id = token.slice(0, i);
  const mac = token.slice(i + 1);
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(id) || !/^[a-f0-9]{32}$/.test(mac)) return null;
  const expected = createHmac("sha256", cookieSecret())
    .update(id)
    .digest("hex")
    .slice(0, 32);
  try {
    const a = Buffer.from(mac, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  return id;
}

function parseCookies(req: VercelRequest): Record<string, string> {
  const raw = req.headers.cookie;
  if (!raw || typeof raw !== "string") return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/** Stable per-browser id via signed httpOnly cookie — not browser-spoofable XFF. */
function resolveDemoClientId(
  req: VercelRequest,
  res: VercelResponse
): string {
  const cookies = parseCookies(req);
  const existing = cookies[DEMO_COOKIE]
    ? verifyClientToken(cookies[DEMO_COOKIE])
    : null;
  const id = existing || randomBytes(16).toString("hex");
  const token = signClientId(id);
  const secure = true;
  res.setHeader(
    "Set-Cookie",
    `${DEMO_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`
  );
  // Mark Secure only when appropriate — Vercel is always HTTPS in prod.
  void secure;
  return id;
}

/** Normalize to path under /v1 (e.g. /gate-j/health). */
function resolveV1Path(req: VercelRequest): string | null {
  try {
    const host = req.headers.host || "localhost";
    const u = new URL(req.url || "/", `https://${host}`);
    let p = u.pathname;
    if (p.startsWith("/api/v1")) {
      p = p.slice("/api/v1".length) || "/";
    } else if (p.startsWith("/api/")) {
      const parts = req.query.path;
      const arr = Array.isArray(parts) ? parts : parts ? [parts] : [];
      if (arr[0] !== "v1") return null;
      p = "/" + arr.slice(1).join("/");
    } else {
      return null;
    }
    if (!p.startsWith("/")) p = `/${p}`;
    return p === "/" ? "/" : p.replace(/\/+$/, "") || "/";
  } catch {
    return null;
  }
}

function pathAllowed(method: string, apiPath: string): boolean {
  const key = `${method.toUpperCase()} ${apiPath}`;
  if (ALLOWED_EXACT.has(key)) return true;
  if (method === "GET" && /^\/portfolios\/[^/]+$/.test(apiPath)) {
    return DEMO_PORTFOLIOS.has(apiPath.split("/")[2]);
  }
  if (method === "GET" && /^\/portfolios\/[^/]+\/balances$/.test(apiPath)) {
    return DEMO_PORTFOLIOS.has(apiPath.split("/")[2]);
  }
  return false;
}

function readRawBody(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body_too_large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sanitizeFixtureDecideBody(
  raw: Buffer
): { ok: true; body: Buffer } | { ok: false; reason: string } {
  let parsed: Record<string, unknown> = {};
  if (raw.length) {
    try {
      parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    } catch {
      return { ok: false, reason: "invalid_json" };
    }
  }
  if (parsed.allow_execute === true || parsed.confirm_funded_trade === true) {
    return { ok: false, reason: "funded_execution_forbidden" };
  }
  if (parsed.acceptance_override === true || parsed.gate_k_execute === true) {
    return { ok: false, reason: "gate_k_execution_forbidden" };
  }
  if (parsed.use_llm === true) {
    return {
      ok: false,
      reason: "use_demo_decide_for_live_ai",
      // clients must call /gate-j/demo-decide
    } as { ok: false; reason: string };
  }
  const scenario = parsed.scenario;
  const isFixture =
    typeof scenario === "string" &&
    ["ALLOWED", "ADAPTED", "REJECTED"].includes(scenario);
  if (!isFixture) {
    return { ok: false, reason: "fixture_scenario_required" };
  }
  parsed.dry_run = true;
  parsed.use_llm = false;
  parsed.allow_execute = false;
  delete parsed.portfolio_id;
  delete parsed.mandate;
  delete parsed.allow_detached_mandate;
  delete parsed.allow_fixture_mandate;
  delete parsed.claimed_owner;
  return { ok: true, body: Buffer.from(JSON.stringify(parsed), "utf8") };
}

function sanitizeDemoDecideBody(
  raw: Buffer
): { ok: true; body: Buffer } | { ok: false; reason: string } {
  let parsed: Record<string, unknown> = {};
  if (raw.length) {
    try {
      parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    } catch {
      return { ok: false, reason: "invalid_json" };
    }
  }
  const forbidden = [
    "allow_execute",
    "confirm_funded_trade",
    "acceptance_override",
    "gate_k_execute",
    "may_sign",
    "withdraw",
    "withdrawal",
    "set_policy",
    "mutate_policy",
    "operator_confirm",
  ];
  for (const k of forbidden) {
    if (parsed[k] === true) {
      return { ok: false, reason: "demo_forbidden_field" };
    }
  }
  // Body ignored for identity — OCI forces portfolio/owner/dry_run.
  // Send empty object so browser cannot inject mandate/fixture escapes.
  return { ok: true, body: Buffer.from("{}", "utf8") };
}

function sanitizeFitBody(
  raw: Buffer
): { ok: true; body: Buffer } | { ok: false; reason: string } {
  let parsed: Record<string, unknown> = {};
  if (raw.length) {
    try {
      parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    } catch {
      return { ok: false, reason: "invalid_json" };
    }
  }
  parsed.dry_run = true;
  parsed.use_llm = false;
  parsed.allow_execute = false;
  delete parsed.acceptance_override;
  return { ok: true, body: Buffer.from(JSON.stringify(parsed), "utf8") };
}

function stripSecretsFromJson(text: string): string {
  return text
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/"OPENROUTER_API_KEY"\s*:\s*"[^"]*"/g, '"OPENROUTER_API_KEY":"[redacted]"')
    .replace(/"api_key"\s*:\s*"[^"]*"/gi, '"api_key":"[redacted]"');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const method = (req.method || "GET").toUpperCase();
  const apiPath = resolveV1Path(req);
  if (!apiPath) {
    res.status(404).json({ reason: "not_found", hint: "Use /api/v1/..." });
    return;
  }

  if (!pathAllowed(method, apiPath)) {
    res.status(403).json({
      reason: "proxy_path_not_allowlisted",
      path: apiPath,
      method,
    });
    return;
  }

  let bodyBuf = Buffer.alloc(0);
  if (method !== "GET" && method !== "HEAD") {
    try {
      bodyBuf = await readRawBody(req);
    } catch (e) {
      res.status(413).json({
        reason: e instanceof Error ? e.message : "body_error",
      });
      return;
    }
  }

  let upstreamPath = apiPath;
  let demoClientId: string | null = null;

  if (method === "POST" && apiPath === "/gate-j/decide") {
    const sanitized = sanitizeFixtureDecideBody(bodyBuf);
    if (!sanitized.ok) {
      res.status(403).json({ reason: sanitized.reason });
      return;
    }
    bodyBuf = sanitized.body;
  }

  if (method === "POST" && apiPath === "/gate-j/demo-decide") {
    if (!liveAiEnabled()) {
      res.status(403).json({ reason: "public_live_ai_disabled" });
      return;
    }
    const sanitized = sanitizeDemoDecideBody(bodyBuf);
    if (!sanitized.ok) {
      res.status(403).json({ reason: sanitized.reason });
      return;
    }
    bodyBuf = sanitized.body;
    upstreamPath = "/gate-j/demo-decide";
    demoClientId = resolveDemoClientId(req, res);
  }

  if (method === "GET" && apiPath === "/gate-j/demo-status") {
    // Public status — no key required upstream, but fine if sent.
    demoClientId = resolveDemoClientId(req, res);
  }

  if (method === "POST" && apiPath === "/gate-j/fit") {
    const sanitized = sanitizeFitBody(bodyBuf);
    if (!sanitized.ok) {
      res.status(403).json({ reason: sanitized.reason });
      return;
    }
    bodyBuf = sanitized.body;
  }

  const base = apiBase();
  if (!base) {
    res.status(503).json({
      reason: "upstream_not_configured",
      detail:
        "Set NIO_API_BASE to Chat 1 trusted HTTPS hostname (e.g. https://nio-api.example/v1). Self-signed OCI IP is not allowed.",
    });
    return;
  }
  if (!/^https:\/\//i.test(base)) {
    res.status(503).json({
      reason: "upstream_must_be_https",
      detail: "NIO_API_BASE must be a trusted https:// origin",
    });
    return;
  }
  if (base.includes("129.225.72.169")) {
    res.status(503).json({
      reason: "self_signed_oci_ip_forbidden",
      detail: "Use Chat 1 DuckDNS/Caddy trusted hostname — not the raw OCI IP.",
    });
    return;
  }

  const key = apiKey();
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  // Never forward browser Authorization / x-api-key — inject server credential only.
  if (key) headers["x-api-key"] = key;

  // Trustworthy demo client identity: signed cookie → synthetic forwarded id.
  // Do NOT forward browser-supplied X-Forwarded-For / X-Real-IP (spoofable).
  if (demoClientId) {
    headers["x-forwarded-for"] = `nio-demo-${demoClientId}`;
    headers["x-nio-demo-client"] = demoClientId;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch(`${base}${upstreamPath}`, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : bodyBuf,
      signal: controller.signal,
      cache: "no-store",
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > MAX_RESPONSE) {
      res.status(502).json({ reason: "upstream_response_too_large" });
      return;
    }
    let text = stripSecretsFromJson(buf.toString("utf8"));
    if (
      (upstreamPath === "/gate-j/demo-decide" || apiPath === "/gate-j/decide") &&
      method === "POST"
    ) {
      try {
        const json = JSON.parse(text) as {
          enforcement?: { may_sign?: boolean };
          summary?: { may_sign?: boolean };
          may_sign?: boolean;
        };
        const maySign =
          json.may_sign ??
          json.enforcement?.may_sign ??
          json.summary?.may_sign ??
          false;
        if (maySign === true) {
          res.status(502).json({
            reason: "upstream_may_sign_true_blocked",
            detail: "Public BFF rejects any decide response with may_sign=true",
          });
          return;
        }
      } catch {
        /* ignore */
      }
    }
    res.status(upstream.status);
    res.setHeader(
      "content-type",
      upstream.headers.get("content-type") || "application/json"
    );
    res.setHeader("Cache-Control", "no-store");
    res.send(text);
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    res.status(502).json({
      reason: aborted ? "upstream_timeout" : "upstream_unreachable",
      detail: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
    });
  } finally {
    clearTimeout(timer);
  }
}
