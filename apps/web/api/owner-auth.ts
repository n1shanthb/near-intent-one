/**
 * Dedicated owner-auth gateway (NOT the public demo BFF).
 *
 * Exact allowlist only:
 *   POST challenge | POST verify | GET session | POST logout | POST portfolios
 *
 * - Requires dedicated NIO_OWNER_AUTH_SECRET (fail closed; never GATE_I_API_KEY).
 * - Session in HttpOnly Secure SameSite=Lax cookie after verify.
 * - CSRF: Origin/Referer host match + double-submit CSRF cookie/header on mutations.
 * - Never proxies Gate K, withdraw submit, or arbitrary paths.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  OWNER_ALLOWED,
  OWNER_CSRF_COOKIE,
  OWNER_SESSION_COOKIE,
  assertMutationCsrf,
  csrfCookieHeader,
  mintCsrfToken,
  normalizeOwnerRoute,
  parseCookies,
  requireOwnerAuthSecret,
  resolveOwnerAction,
  sessionCookieHeader,
  stripSessionTokenFromBody,
  unwrapSessionToken,
} from "./ownerAuthSecurity.mjs";

const MAX_BODY = 32 * 1024;
const TIMEOUT_MS = 20_000;

function apiBase(): string {
  return (process.env.NIO_API_BASE || process.env.GATE_I_UPSTREAM || "").replace(
    /\/$/,
    ""
  );
}

function apiKey(): string {
  return (process.env.GATE_I_API_KEY || "").trim();
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

function appendSetCookie(res: VercelResponse, value: string) {
  const prev = res.getHeader("Set-Cookie");
  if (!prev) {
    res.setHeader("Set-Cookie", value);
    return;
  }
  const list = Array.isArray(prev) ? prev.map(String) : [String(prev)];
  list.push(value);
  res.setHeader("Set-Cookie", list);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-NIO-Owner-Gateway", "1");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const secretRes = requireOwnerAuthSecret();
  if (!secretRes.ok) {
    res.status(503).json({
      reason: secretRes.reason,
      detail:
        "Owner gateway requires dedicated NIO_OWNER_AUTH_SECRET (≥32 chars, distinct from GATE_I_API_KEY).",
    });
    return;
  }
  const secret = secretRes.secret;

  const method = (req.method || "GET").toUpperCase();
  const action = resolveOwnerAction(
    req.url,
    typeof req.headers.host === "string" ? req.headers.host : undefined
  );
  const normalizedKey = normalizeOwnerRoute(method, action);

  if (!OWNER_ALLOWED.has(normalizedKey)) {
    res.status(403).json({
      reason: "owner_gateway_path_not_allowlisted",
      detail:
        "Only challenge/verify/session/logout/portfolios lookup are exposed.",
      attempted: normalizedKey,
    });
    return;
  }

  const cookies = parseCookies(
    typeof req.headers.cookie === "string" ? req.headers.cookie : undefined
  );
  const csrfHeader =
    (typeof req.headers["x-nio-owner-csrf"] === "string"
      ? req.headers["x-nio-owner-csrf"]
      : "") || "";

  const csrfCheck = assertMutationCsrf({
    method,
    host: typeof req.headers.host === "string" ? req.headers.host : undefined,
    origin: typeof req.headers.origin === "string" ? req.headers.origin : undefined,
    referer:
      typeof req.headers.referer === "string" ? req.headers.referer : undefined,
    csrfCookie: cookies[OWNER_CSRF_COOKIE],
    csrfHeader,
  });
  if (!csrfCheck.ok) {
    res.status(403).json({ reason: csrfCheck.reason });
    return;
  }

  const base = apiBase();
  if (!base || !/^https:\/\//i.test(base)) {
    res.status(503).json({
      reason: "upstream_not_configured",
      detail: "NIO_API_BASE must be trusted https://…/v1",
    });
    return;
  }

  let bodyBuf = Buffer.alloc(0);
  if (method !== "GET" && method !== "HEAD") {
    try {
      if (typeof req.body === "string") {
        bodyBuf = Buffer.from(req.body);
      } else if (req.body && typeof req.body === "object") {
        bodyBuf = Buffer.from(JSON.stringify(req.body));
      } else {
        bodyBuf = await readRawBody(req);
      }
    } catch {
      res.status(413).json({ reason: "body_too_large" });
      return;
    }
  }

  const sessionFromCookie = cookies[OWNER_SESSION_COOKIE]
    ? unwrapSessionToken(cookies[OWNER_SESSION_COOKIE], secret)
    : null;

  let upstreamPath = "";
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };

  if (normalizedKey === "POST /challenge") {
    upstreamPath = "/owner/challenge";
  } else if (normalizedKey === "POST /verify") {
    upstreamPath = "/owner/verify";
  } else if (normalizedKey === "GET /session") {
    upstreamPath = "/owner/session";
    if (!sessionFromCookie) {
      // Mint CSRF for subsequent mutations even when unauthenticated.
      appendSetCookie(res, csrfCookieHeader(mintCsrfToken()));
      res.status(401).json({ ok: false, reason: "no_owner_session" });
      return;
    }
    headers["x-nio-owner-session"] = sessionFromCookie;
  } else if (normalizedKey === "POST /logout") {
    upstreamPath = "/owner/logout";
    if (!sessionFromCookie) {
      appendSetCookie(res, sessionCookieHeader(null, secret));
      appendSetCookie(res, csrfCookieHeader(null));
      res.status(200).json({ ok: true });
      return;
    }
    headers["x-nio-owner-session"] = sessionFromCookie;
  } else if (normalizedKey === "POST /portfolios") {
    upstreamPath = "/portfolios";
    if (!sessionFromCookie) {
      res.status(401).json({
        status: "blocked",
        reason: "owner_session_required",
      });
      return;
    }
    headers["x-nio-owner-session"] = sessionFromCookie;
    const keyVal = apiKey();
    if (!keyVal) {
      res.status(503).json({ reason: "service_credential_missing" });
      return;
    }
    headers["x-api-key"] = keyVal;
  } else {
    res.status(403).json({ reason: "owner_gateway_path_not_allowlisted" });
    return;
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
    const text = await upstream.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = { raw: text.slice(0, 200) };
    }

    if (normalizedKey === "POST /verify" && upstream.ok && json.ok) {
      const session = json.session as { token?: string } | undefined;
      if (session?.token) {
        appendSetCookie(res, sessionCookieHeader(session.token, secret));
        appendSetCookie(res, csrfCookieHeader(mintCsrfToken()));
      }
      json = stripSessionTokenFromBody(json);
    }
    if (normalizedKey === "POST /logout" && upstream.ok) {
      appendSetCookie(res, sessionCookieHeader(null, secret));
      appendSetCookie(res, csrfCookieHeader(null));
    }
    if (normalizedKey === "GET /session" && upstream.ok) {
      // Refresh CSRF for authenticated session.
      if (!cookies[OWNER_CSRF_COOKIE]) {
        appendSetCookie(res, csrfCookieHeader(mintCsrfToken()));
      }
    }

    res.status(upstream.status);
    res.setHeader(
      "content-type",
      upstream.headers.get("content-type") || "application/json"
    );
    res.send(JSON.stringify(json));
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    res.status(502).json({
      reason: aborted ? "upstream_timeout" : "upstream_unreachable",
      detail:
        e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
    });
  } finally {
    clearTimeout(timer);
  }
}
