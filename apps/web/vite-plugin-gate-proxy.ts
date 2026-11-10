/**
 * Server-side Gate I/J proxy for local Vite (and preview).
 * Injects GATE_I_API_KEY from packages/services/.env — never VITE_*.
 * Allowlists dry-run Gate J + public health only. No funded execution.
 */
import type { Plugin } from "vite";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVICES_ENV = join(ROOT, "packages", "services", ".env");

const ALLOWED = new Set([
  "GET /health",
  "GET /gate-j/health",
  "GET /gate-j/scenarios",
  "GET /gate-j/decisions",
  "GET /gate-j/market",
  "POST /gate-j/decide",
  "POST /gate-j/fit",
  "POST /gate-j/market",
  "GET /portfolios",
]);

function loadServerEnv(): { apiKey: string; upstream: string } {
  let apiKey = process.env.GATE_I_API_KEY || "";
  let upstream =
    process.env.GATE_I_UPSTREAM ||
    process.env.VITE_GATE_I_UPSTREAM ||
    "http://127.0.0.1:8787/v1";
  if (existsSync(SERVICES_ENV)) {
    const text = readFileSync(SERVICES_ENV, "utf8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      if (k === "GATE_I_API_KEY" && !apiKey) apiKey = v;
      if (k === "GATE_I_UPSTREAM" && !process.env.GATE_I_UPSTREAM) upstream = v;
    }
  }
  return { apiKey, upstream: upstream.replace(/\/$/, "") };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function pathAllowed(method: string, apiPath: string): boolean {
  const key = `${method.toUpperCase()} ${apiPath}`;
  if (ALLOWED.has(key)) return true;
  // Portfolio balances read-only
  if (
    method === "GET" &&
    /^\/portfolios\/[^/]+\/balances$/.test(apiPath)
  ) {
    return true;
  }
  if (method === "GET" && /^\/portfolios\/[^/]+$/.test(apiPath)) {
    return true;
  }
  return false;
}

function blockFundedBody(buf: Buffer): string | null {
  if (!buf.length) return null;
  try {
    const body = JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
    if (body.allow_execute === true || body.confirm_funded_trade === true) {
      return "funded_execution_blocked_by_proxy";
    }
    if (body.dry_run === false) {
      return "dry_run_required_by_proxy";
    }
  } catch {
    /* forward as-is; upstream validates */
  }
  return null;
}

async function proxy(
  req: IncomingMessage,
  res: ServerResponse,
  apiPath: string
) {
  const method = (req.method || "GET").toUpperCase();
  if (!pathAllowed(method, apiPath)) {
    res.statusCode = 403;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ reason: "proxy_path_not_allowlisted", path: apiPath }));
    return;
  }

  const { apiKey, upstream } = loadServerEnv();
  const target = new URL(`${upstream}${apiPath}`);
  const isHttps = target.protocol === "https:";
  const bodyBuf =
    method === "GET" || method === "HEAD" ? Buffer.alloc(0) : await readBody(req);

  if (method === "POST") {
    const blocked = blockFundedBody(bodyBuf);
    if (blocked) {
      res.statusCode = 403;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ reason: blocked }));
      return;
    }
  }

  const headers: Record<string, string | number | string[] | undefined> = {
    "content-type": "application/json",
    accept: "application/json",
    host: target.host,
  };
  if (apiKey) headers["x-api-key"] = apiKey;
  if (bodyBuf.length) headers["content-length"] = bodyBuf.length;

  const lib = isHttps ? httpsRequest : httpRequest;
  const upstreamReq = lib(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      method,
      headers,
      // Diagnostic only for Chat 1 self-signed OCI TLS; prefer trusted hostname.
      rejectUnauthorized: process.env.GATE_I_TLS_INSECURE === "1" ? false : true,
    },
    (upRes) => {
      res.statusCode = upRes.statusCode || 502;
      const ct = upRes.headers["content-type"];
      if (ct) res.setHeader("content-type", ct);
      upRes.pipe(res);
    }
  );
  upstreamReq.on("error", (e) => {
    res.statusCode = 502;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        reason: "upstream_unreachable",
        detail: String(e.message || e).slice(0, 200),
      })
    );
  });
  if (bodyBuf.length) upstreamReq.write(bodyBuf);
  upstreamReq.end();
}

export function gateProxyPlugin(): Plugin {
  return {
    name: "nio-gate-proxy",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url || "";
        if (!url.startsWith("/api/v1")) return next();
        const apiPath = url.slice("/api/v1".length).split("?")[0] || "/";
        try {
          await proxy(req, res, apiPath.startsWith("/") ? apiPath : `/${apiPath}`);
        } catch (e) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              reason: "proxy_error",
              detail: e instanceof Error ? e.message : String(e),
            })
          );
        }
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url || "";
        if (!url.startsWith("/api/v1")) return next();
        const apiPath = url.slice("/api/v1".length).split("?")[0] || "/";
        try {
          await proxy(req, res, apiPath.startsWith("/") ? apiPath : `/${apiPath}`);
        } catch (e) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              reason: "proxy_error",
              detail: e instanceof Error ? e.message : String(e),
            })
          );
        }
      });
    },
  };
}
