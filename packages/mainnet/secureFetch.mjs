/**
 * TLS-verifying HTTPS helper for mainnet 1Click.
 * Optional NIO_BIND_ADDRESS pins the local interface (mobile hotspot) when a
 * Fortinet path still exists on another NIC.
 * Always verifies TLS. Never disables certificate validation.
 */
import https from "node:https";
import { networkInterfaces } from "node:os";
import { URL } from "node:url";

export function detectMobileBindAddress(env = process.env) {
  if (env.NIO_BIND_ADDRESS != null && String(env.NIO_BIND_ADDRESS).trim() !== "") {
    const forced = String(env.NIO_BIND_ADDRESS).trim().toLowerCase();
    // Explicit no-bind: use OS default route (needed when mobile is default and
    // Node localAddress bind to the hotspot IP times out on Windows).
    if (forced === "none" || forced === "off" || forced === "-" || forced === "default") {
      return null;
    }
    return String(env.NIO_BIND_ADDRESS).trim();
  }
  // Windows: auto-binding to hotspot IPs often ETIMEDOUT under Node. Prefer OS
  // default route unless the operator pins NIO_BIND_ADDRESS explicitly.
  if (process.platform === "win32") {
    return null;
  }
  const nets = networkInterfaces();
  const candidates = [];
  for (const [, addrs] of Object.entries(nets)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family !== "IPv4" && a.family !== 4) continue;
      if (a.internal) continue;
      const ip = a.address;
      if (ip.startsWith("192.168.56.")) continue; // VirtualBox
      if (ip.startsWith("172.24.")) continue; // WSL
      if (ip.startsWith("169.254.")) continue;
      if (ip.startsWith("172.18.")) continue; // college FortiGate LAN
      candidates.push(ip);
    }
  }
  const rank = (ip) => {
    if (ip.startsWith("10.")) return 0;
    if (ip.startsWith("172.16.")) return 1;
    if (ip.startsWith("192.168.")) return 2;
    return 9;
  };
  candidates.sort((a, b) => rank(a) - rank(b));
  return candidates[0] || null;
}

/**
 * @returns {Promise<{ ok: boolean, status: number, headers: object, text: string, json: any, bind: string|null, error?: string }>}
 */
export function secureFetch(url, init = {}) {
  const env = init.env || process.env;
  const localAddress =
    init.localAddress !== undefined
      ? init.localAddress
      : detectMobileBindAddress(env);
  const method = (init.method || "GET").toUpperCase();
  const headers = { ...(init.headers || {}) };
  const body = init.body != null ? String(init.body) : null;
  const u = new URL(url);

  // Only force IPv4 + localAddress when pinning a NIC (dual-home / Fortinet escape).
  // Unbound requests use Node defaults — forced family:4 currently times out on
  // some Windows mobile hotspots even though direct A-record IPv4 works.
  const agent = new https.Agent({
    keepAlive: true,
    rejectUnauthorized: true,
    ...(localAddress ? { family: 4, localAddress } : {}),
  });

  return new Promise((resolve) => {
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        headers,
        agent,
        servername: u.hostname,
        rejectUnauthorized: true,
        ...(localAddress ? { family: 4, localAddress } : {}),
        timeout: init.timeoutMs || 60_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            headers: res.headers,
            text,
            json,
            bind: localAddress,
          });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("socket_timeout"));
    });
    req.on("error", (e) => {
      resolve({
        ok: false,
        status: 0,
        headers: {},
        text: "",
        json: null,
        bind: localAddress,
        error: String(e.message || e),
        cause: e.cause?.message || e.code || null,
      });
    });
    if (body) req.write(body);
    req.end();
  });
}
