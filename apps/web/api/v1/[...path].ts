/**
 * Production Vercel BFF — allowlisted proxy to OCI NIO API.
 * Credentials stay server-side (GATE_I_API_KEY). Never trust browser auth headers.
 * No TLS bypass. No funded execution / Gate K signing.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";

const DEMO_PORTFOLIOS = new Set(["i-a-a4e7", "i-b-a4e7"]);
const MAX_BODY = 64 * 1024;
const TIMEOUT_MS = 55_000;
const MAX_RESPONSE = 512 * 1024;

const ALLOWED_EXACT = new Set([
  "GET /health",
  "GET /gate-j/health",
  "GET /gate-j/scenarios",
  "GET /gate-j/decisions",
  "GET /gate-j/market",
  "POST /gate-j/decide",
  "POST /gate-j/fit",
]);

function apiBase(): string {
  const raw =
    process.env.NIO_API_BASE ||
    process.env.GATE_I_UPSTREAM ||
    "";
  return raw.replace(/\/$/, "");
}

function apiKey(): string {
  return (process.env.GATE_I_API_KEY || "").trim();
}

function liveAiEnabled(): boolean {
  return process.env.NIO_PUBLIC_LIVE_AI === "true";
}

function joinPath(parts: string[] | string | undefined): string {
  if (!parts) return "/";
  const arr = Array.isArray(parts) ? parts : [parts];
  return "/" + arr.map((p) => String(p).replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
}

function pathAllowed(method: string, apiPath: string): boolean {
  const key = `${method.toUpperCase()} ${apiPath}`;
  if (ALLOWED_EXACT.has(key)) return true;
  if (method === "GET" && /^\/portfolios\/[^/]+$/.test(apiPath)) {
    const id = apiPath.split("/")[2];
    return DEMO_PORTFOLIOS.has(id);
  }
  if (method === "GET" && /^\/portfolios\/[^/]+\/balances$/.test(apiPath)) {
    const id = apiPath.split("/")[2];
    return DEMO_PORTFOLIOS.has(id);
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

function sanitizeDecideBody(raw: Buffer): { ok: true; body: Buffer } | { ok: false; reason: string } {
  let parsed: Record<string, unknown> = {};
  if (raw.length) {
    try {
      parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    } catch {
      return { ok: false, reason: "invalid_json" };
    }
  }

  // Hard public-demo constraints
  if (parsed.allow_execute === true || parsed.confirm_funded_trade === true) {
    return { ok: false, reason: "funded_execution_forbidden" };
  }
  if (parsed.acceptance_override === true || parsed.gate_k_execute === true) {
    return { ok: false, reason: "gate_k_execution_forbidden" };
  }

  const scenario = parsed.scenario;
  const isFixture =
    typeof scenario === "string" &&
    ["ALLOWED", "ADAPTED", "REJECTED"].includes(scenario);

  if (parsed.use_llm === true) {
    if (!liveAiEnabled()) {
      return { ok: false, reason: "public_live_ai_disabled" };
    }
    // Fixed demo portfolio only — ignore client weaker mandates
    delete parsed.mandate;
    delete parsed.allow_detached_mandate;
    delete parsed.allow_fixture_mandate;
    parsed.portfolio_id = "i-a-a4e7";
    parsed.claimed_owner = "nio-i-a4e7-a-owner.testnet";
    parsed.use_llm = true;
    parsed.dry_run = true;
    parsed.allow_execute = false;
  } else if (isFixture) {
    parsed.dry_run = true;
    parsed.use_llm = false;
    delete parsed.portfolio_id;
    delete parsed.mandate;
  } else {
    // Fit / other decide variants — still force dry-run
    parsed.dry_run = true;
    parsed.allow_execute = false;
  }

  return { ok: true, body: Buffer.from(JSON.stringify(parsed), "utf8") };
}

function sanitizeFitBody(raw: Buffer): { ok: true; body: Buffer } | { ok: false; reason: string } {
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
  // Defense in depth — never echo upstream secrets if mishandled
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
  const apiPath = joinPath(req.query.path as string[] | string | undefined);

  if (!pathAllowed(method, apiPath)) {
    res.status(403).json({
      reason: "proxy_path_not_allowlisted",
      path: apiPath,
      method,
    });
    return;
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

  // Reject known self-signed IP production path
  if (base.includes("129.225.72.169")) {
    res.status(503).json({
      reason: "self_signed_oci_ip_forbidden",
      detail: "Use Chat 1 DuckDNS/Caddy trusted hostname — not the raw OCI IP.",
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

  if (method === "POST" && apiPath === "/gate-j/decide") {
    const sanitized = sanitizeDecideBody(bodyBuf);
    if (!sanitized.ok) {
      res.status(403).json({ reason: sanitized.reason });
      return;
    }
    bodyBuf = sanitized.body;
  }
  if (method === "POST" && apiPath === "/gate-j/fit") {
    const sanitized = sanitizeFitBody(bodyBuf);
    if (!sanitized.ok) {
      res.status(403).json({ reason: sanitized.reason });
      return;
    }
    bodyBuf = sanitized.body;
  }

  const key = apiKey();
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (key) headers["x-api-key"] = key;
  // Strip any browser-supplied credentials — never forward them

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const upstream = await fetch(`${base}${apiPath}`, {
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

    let text = buf.toString("utf8");
    text = stripSecretsFromJson(text);

    // Live AI: require may_sign=false when response is a decide payload
    if (apiPath === "/gate-j/decide" && method === "POST") {
      try {
        const json = JSON.parse(text) as {
          enforcement?: { may_sign?: boolean };
          summary?: { may_sign?: boolean };
          dry_run?: boolean;
        };
        const maySign =
          json.enforcement?.may_sign ?? json.summary?.may_sign ?? false;
        if (maySign === true) {
          res.status(502).json({
            reason: "upstream_may_sign_true_blocked",
            detail: "Public BFF rejects any decide response with may_sign=true",
          });
          return;
        }
      } catch {
        /* non-JSON handled below */
      }
    }

    const ct = upstream.headers.get("content-type") || "application/json";
    res.status(upstream.status);
    res.setHeader("content-type", ct);
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
