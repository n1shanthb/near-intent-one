/**
 * Pure helpers for the owner-auth gateway — unit-tested.
 * Cookie integrity secret must be dedicated NIO_OWNER_AUTH_SECRET (never GATE_I_API_KEY).
 */
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

export const OWNER_SESSION_COOKIE = "nio_owner_session";
export const OWNER_CSRF_COOKIE = "nio_owner_csrf";
export const MIN_OWNER_SECRET_LEN = 32;

export const OWNER_ALLOWED = new Set([
  "POST /challenge",
  "POST /verify",
  "GET /session",
  "POST /logout",
  "POST /portfolios",
]);

/** Fail closed — no API-key fallback, no hardcoded dev secret. */
export function requireOwnerAuthSecret(env = process.env) {
  const secret = String(env.NIO_OWNER_AUTH_SECRET || "").trim();
  if (!secret) {
    return { ok: false, reason: "owner_auth_secret_missing" };
  }
  if (secret.length < MIN_OWNER_SECRET_LEN) {
    return { ok: false, reason: "owner_auth_secret_too_short" };
  }
  const apiKey = String(env.GATE_I_API_KEY || "").trim();
  if (apiKey && secret === apiKey) {
    return { ok: false, reason: "owner_auth_secret_must_differ_from_api_key" };
  }
  return { ok: true, secret };
}

export function parseCookies(raw) {
  if (!raw || typeof raw !== "string") return {};
  const out = {};
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

export function wrapSessionToken(token, secret) {
  const mac = createHmac("sha256", secret).update(token).digest("hex").slice(0, 32);
  return `${token}~${mac}`;
}

export function unwrapSessionToken(wrapped, secret) {
  const i = wrapped.lastIndexOf("~");
  if (i <= 0) return null;
  const token = wrapped.slice(0, i);
  const mac = wrapped.slice(i + 1);
  const expected = createHmac("sha256", secret)
    .update(token)
    .digest("hex")
    .slice(0, 32);
  try {
    const a = Buffer.from(mac, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  if (!token.startsWith("nio1.")) return null;
  return token;
}

export function sessionCookieHeader(token, secret) {
  if (!token) {
    return `${OWNER_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  }
  const wrapped = encodeURIComponent(wrapSessionToken(token, secret));
  return `${OWNER_SESSION_COOKIE}=${wrapped}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=1800`;
}

export function csrfCookieHeader(csrf) {
  if (!csrf) {
    return `${OWNER_CSRF_COOKIE}=; Path=/; Secure; SameSite=Lax; Max-Age=0`;
  }
  return `${OWNER_CSRF_COOKIE}=${encodeURIComponent(csrf)}; Path=/; Secure; SameSite=Lax; Max-Age=1800`;
}

export function mintCsrfToken() {
  return randomBytes(24).toString("base64url");
}

export function assertMutationCsrf(input) {
  const method = String(input.method || "").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return { ok: true };
  }

  const host = String(input.host || "")
    .split(":")[0]
    ?.toLowerCase();
  if (!host) return { ok: false, reason: "csrf_missing_host" };

  const originHost = hostFromUrl(input.origin);
  const refererHost = hostFromUrl(input.referer);
  const source = originHost || refererHost;
  if (!source) {
    return { ok: false, reason: "csrf_missing_origin" };
  }
  if (!hostsCompatible(source, host)) {
    return { ok: false, reason: "csrf_origin_mismatch" };
  }

  const cookie = String(input.csrfCookie || "").trim();
  const header = String(input.csrfHeader || "").trim();
  if (cookie) {
    if (!header || cookie.length !== header.length) {
      return { ok: false, reason: "csrf_token_mismatch" };
    }
    try {
      if (!timingSafeEqual(Buffer.from(cookie), Buffer.from(header))) {
        return { ok: false, reason: "csrf_token_mismatch" };
      }
    } catch {
      return { ok: false, reason: "csrf_token_mismatch" };
    }
  }

  return { ok: true };
}

function hostFromUrl(value) {
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hostsCompatible(source, host) {
  if (source === host) return true;
  if (
    (host === "localhost" || host === "127.0.0.1") &&
    (source === "localhost" || source === "127.0.0.1")
  ) {
    return true;
  }
  // Vercel production alias vs deployment subdomain for the same project.
  if (source.endsWith(".vercel.app") && host.endsWith(".vercel.app")) {
    return true;
  }
  return false;
}

export function stripSessionTokenFromBody(json) {
  if (!json.session || typeof json.session !== "object") return json;
  const sess = { ...json.session };
  delete sess.token;
  sess.cookie = true;
  return { ...json, session: sess };
}

export function resolveOwnerAction(url, host) {
  try {
    const u = new URL(url || "/", `https://${host || "localhost"}`);
    const q = u.searchParams.get("action");
    if (q) return `/${q.replace(/^\//, "")}`;
    const parts = u.pathname.replace(/\/+$/, "").split("/");
    const idx = parts.indexOf("owner-auth");
    if (idx >= 0 && parts[idx + 1]) return `/${parts[idx + 1]}`;
    return "/";
  } catch {
    return "/";
  }
}

export function normalizeOwnerRoute(method, action) {
  const m = String(method || "").toUpperCase();
  if (m === "GET" && (action === "/" || action === "/session")) {
    return "GET /session";
  }
  return `${m} ${action === "/" ? "/session" : action}`;
}
