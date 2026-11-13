#!/usr/bin/env node
/**
 * Checkpoint J3 — mainnet agent backend (observation-only).
 *
 * Env:
 *   NIO_NETWORK=mainnet
 *   NIO_AGENT_OPS_KEY_PATH=<absolute path outside repo>
 *   GATE_I_API_KEY=<service key for privileged routes>
 *   NIO_MAINNET_PORT=8788 (default)
 *
 * Never broadcasts. Never serves private keys. Distinct from testnet api-server.mjs.
 */
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { loadServicesEnv } from "../gate-j/llm.mjs";
import { authorizeService, allowOpenDevMode } from "./apiAuth.mjs";
import { createMainnetAgentRuntime } from "../mainnet/agentRuntime.mjs";
import { runMainnetObservation } from "../mainnet/observe.mjs";
import { assertMainnetBroadcastAllowed, mainnetExecutionGates } from "../mainnet/safetyGates.mjs";
import { MAINNET_IDENTITIES } from "../mainnet/identities.mjs";
import { redactSecrets } from "../mainnet/agentCredentials.mjs";

loadServicesEnv();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = Number(process.env.NIO_MAINNET_PORT || process.env.PORT || 8788);
const HOST = process.env.NIO_MAINNET_HOST || process.env.GATE_I_HOST || "127.0.0.1";
const API_KEY = process.env.GATE_I_API_KEY || process.env.NIO_MAINNET_API_KEY || "";
const DATA =
  process.env.NIO_MAINNET_DATA_DIR || join(ROOT, ".gate-i-data", "mainnet-observe");
const CORS_ORIGINS = (process.env.GATE_I_CORS_ORIGINS || "http://127.0.0.1:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const network = String(process.env.NIO_NETWORK || process.env.NEAR_NETWORK || "")
  .trim()
  .toLowerCase();

if (network !== "mainnet") {
  console.error("refusing to start: set NIO_NETWORK=mainnet for mainnet-api-server");
  process.exit(1);
}

if (!API_KEY && !allowOpenDevMode(process.env, { remoteAddress: "127.0.0.1" })) {
  console.error(
    "refusing to start: GATE_I_API_KEY (or NIO_MAINNET_API_KEY) required unless GATE_I_ALLOW_OPEN_DEV=1 on localhost"
  );
  process.exit(1);
}

mkdirSync(DATA, { recursive: true });

let runtime = null;
const startedAt = new Date().toISOString();

function json(req, res, status, body) {
  const origin = req.headers.origin || "";
  const allow =
    CORS_ORIGINS.includes("*") || CORS_ORIGINS.includes(origin) ? origin || "*" : CORS_ORIGINS[0];
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": allow || "*",
    "access-control-allow-headers": "content-type, x-api-key, authorization",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

async function boot() {
  runtime = await createMainnetAgentRuntime({ env: process.env });
  if (!runtime.ok) {
    console.error(
      "mainnet agent startup validation FAILED:",
      runtime.validation?.reason || "unknown"
    );
    writeFileSync(
      join(DATA, "boot-failed.json"),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          reason: runtime.validation?.reason,
          failures: runtime.validation?.failures,
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  writeFileSync(
    join(DATA, "boot.json"),
    JSON.stringify(
      {
        at: startedAt,
        network: "mainnet",
        agent: MAINNET_IDENTITIES.agent,
        public_key: runtime.public_key,
        policy: runtime.policy,
        gates: runtime.gates,
        local_sign_ok: runtime.local_sign?.ok,
        construction_digest: runtime.local_sign?.construction_digest,
        observation_only: true,
        note: "no secrets logged",
      },
      null,
      2
    )
  );

  console.log(
    JSON.stringify({
      boot: "ok",
      network: "mainnet",
      agent: MAINNET_IDENTITIES.agent,
      public_key: runtime.public_key,
      mandate_epoch: runtime.policy?.mandate_epoch,
      paused: runtime.policy?.paused,
      local_sign: runtime.local_sign?.ok,
      gates: runtime.gates,
      listen: `${HOST}:${PORT}`,
    })
  );
}

async function handle(req, res) {
  if (req.method === "OPTIONS") return json(req, res, 204, {});

  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  let path = url.pathname;
  if (path.startsWith("/v1")) path = path.slice(3) || "/";

  const mutating =
    req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
  const isPublicGet =
    req.method === "GET" &&
    (path === "/health" || path === "/mainnet/health");

  // Privileged routes (including read-only observe) require service auth when configured.
  // Execution routes always require auth and are still hard-blocked by broadcast gates.
  if (!isPublicGet) {
    const auth = authorizeService(req, {
      mutating: true,
      apiKey: API_KEY,
      env: process.env,
    });
    if (!auth.ok) {
      return json(req, res, 401, {
        ok: false,
        reason: auth.reason || "unauthorized",
        note: "Public callers cannot trigger signing, key use, or broadcasts",
      });
    }
  }

  try {
    if (req.method === "GET" && (path === "/health" || path === "/mainnet/health")) {
      const gates = mainnetExecutionGates(process.env);
      return json(req, res, 200, {
        ok: Boolean(runtime?.ok),
        network: "mainnet",
        service: "nio-mainnet-agent-observe",
        started_at: startedAt,
        agent: MAINNET_IDENTITIES.agent,
        policy: MAINNET_IDENTITIES.policy,
        observation_only: true,
        gates: {
          funded_trading: gates.funded_trading,
          mainnet_broadcast_enabled: gates.mainnet_broadcast_enabled,
          autonomous_execution_enabled: gates.autonomous_execution_enabled,
        },
        runtime_ready: Boolean(runtime?.ok),
        local_sign_ok: runtime?.local_sign?.ok ?? null,
      });
    }

    if (req.method === "GET" && path === "/mainnet/observe") {
      const snap = await runMainnetObservation({
        rpc: runtime.rpc,
        env: process.env,
      });
      return json(req, res, 200, snap);
    }

    if (req.method === "GET" && path === "/mainnet/balances") {
      const snap = await runMainnetObservation({
        rpc: runtime.rpc,
        env: process.env,
      });
      return json(req, res, 200, {
        ok: true,
        near: snap.balances.near,
        evm: snap.balances.evm,
        mpc: snap.mpc,
      });
    }

    if (req.method === "GET" && path === "/mainnet/policy") {
      return json(req, res, 200, {
        ok: true,
        policy: runtime.policy,
        identities: runtime.identities,
        gates: runtime.gates,
      });
    }

    if (req.method === "GET" && path === "/mainnet/local-sign-check") {
      return json(req, res, 200, {
        ok: runtime.local_sign?.ok === true,
        construction_digest: runtime.local_sign?.construction_digest,
        signature_verified: runtime.local_sign?.signature_verified,
        broadcast: false,
        note: "Signed payload bytes intentionally omitted",
      });
    }

    // All execution / broadcast attempts — hard refuse
    if (
      mutating &&
      (path === "/mainnet/execute" ||
        path === "/mainnet/broadcast" ||
        path === "/mainnet/sign" ||
        path === "/gate-k/decide" ||
        path === "/agent/tick")
    ) {
      const body = await readBody(req).catch(() => ({}));
      const gate = assertMainnetBroadcastAllowed(process.env);
      // Refuse even authenticated callers in J3
      return json(req, res, 403, {
        ok: false,
        submitted: false,
        reason: gate.reason,
        gates: gate.gates,
        path,
        note:
          "Observation-only HTTP API — execution endpoints disabled. First live canary is local CLI (J8B-0), not an agent tick.",
        body_ignored: Boolean(body && Object.keys(body).length),
      });
    }

    if (req.method === "POST" && path === "/mainnet/submit") {
      const result = await runtime.submitTransaction({});
      return json(req, res, 403, redactSecrets(result));
    }

    return json(req, res, 404, { ok: false, reason: "not_found", path });
  } catch (e) {
    return json(req, res, 500, {
      ok: false,
      reason: "internal_error",
      detail: String(e.message || e).slice(0, 200),
    });
  }
}

await boot();
const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    json(req, res, 500, { ok: false, reason: String(e.message || e).slice(0, 200) });
  });
});
server.listen(PORT, HOST, () => {
  console.log(`mainnet observe API on http://${HOST}:${PORT}`);
});
