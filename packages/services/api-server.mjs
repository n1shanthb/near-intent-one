#!/usr/bin/env node
/**
 * Gate I3 — deployable Gate I HTTP API (testnet).
 * Secrets stay server-side. No software bypass for nio-c-* Ledger demos.
 * Owner signing keys / attestor seeds never returned to browsers.
 *
 * Env: see packages/services/.env.example
 * Local:  node packages/services/api-server.mjs
 * UI:     VITE_GATE_I_API_BASE=https://<host>/v1
 */
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "./store.mjs";
import { createAttestorService } from "./attestor.mjs";
import { createAgentService } from "./agent.mjs";
import { createReconcilerService } from "./reconciler.mjs";
import { createGateJHandlers, handleGateJRoute } from "./gate-j-routes.mjs";
import { loadServicesEnv } from "../gate-j/llm.mjs";
import {
  assertNotDemo,
  connectWithAccounts,
  eth,
  ethBalance,
  erc20Balance,
  intentsMtBalance,
  pickRpc,
  USDC_SEPOLIA,
  viewFunction,
  DEMO_PREFIX,
} from "../../scripts/lib/near-live.mjs";

loadServicesEnv();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CREDS = join(ROOT, ".near-credentials", "testnet");
const EVIDENCE = join(ROOT, "evidence", "live");
const DATA = process.env.GATE_I_DATA_DIR || join(ROOT, ".gate-i-data");
const PORT = Number(process.env.GATE_I_PORT || process.env.PORT || 8787);
const HOST = process.env.GATE_I_HOST || "0.0.0.0";
const NETWORK = process.env.NEAR_NETWORK || "testnet";
const API_KEY = process.env.GATE_I_API_KEY || "";
const CORS_ORIGINS = (process.env.GATE_I_CORS_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (NETWORK !== "testnet") {
  console.error("refusing to start: NEAR_NETWORK must be testnet");
  process.exit(1);
}

mkdirSync(DATA, { recursive: true });
const store = openStore(DATA);
const attestor = createAttestorService({
  seedPath: join(DATA, "attestor.seed.json"),
});

let rpc;
let agentSvc;
let reconSvc;
let gateJ;
const startedAt = new Date().toISOString();

function corsHeaders(req) {
  const origin = req.headers.origin || "";
  const allow =
    CORS_ORIGINS.includes("*") || CORS_ORIGINS.includes(origin)
      ? CORS_ORIGINS.includes("*")
        ? "*"
        : origin
      : CORS_ORIGINS[0] || "*";
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-headers": "content-type, authorization, x-api-key",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-max-age": "86400",
  };
}

function json(req, res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    ...corsHeaders(req),
  });
  res.end(payload);
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
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** Mutating routes require API key when GATE_I_API_KEY is set. Health stays public. */
function authorize(req, { mutating }) {
  if (!mutating || !API_KEY) return { ok: true };
  const hdr =
    req.headers["x-api-key"] ||
    (String(req.headers.authorization || "").startsWith("Bearer ")
      ? String(req.headers.authorization).slice(7)
      : "");
  if (hdr !== API_KEY) return { ok: false, reason: "unauthorized" };
  return { ok: true };
}

function loadProvision() {
  const p = join(EVIDENCE, "gate-i-provision.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

function syncProvisionIntoStore() {
  const provision = loadProvision();
  if (!provision) return;
  for (const u of provision.users || []) {
    assertNotDemo(u.policy);
    store.upsertPortfolio(u.portfolio_id, {
      portfolio_id: u.portfolio_id,
      owner_account: u.owner,
      policy_contract: u.policy,
      agent_account: u.agent,
      reconciler_account: u.reconciler,
      derivation_path: u.derivation_path,
      intents_signer_id: u.evm,
      created_at: provision.created_at,
      deploy_status: "ready",
      deploy_txs: [
        { label: "deploy", tx_hash: u.deploy_tx || "see-provision" },
        { label: "set_policy", tx_hash: u.set_policy_tx || "see-provision" },
      ],
      network: "testnet",
    });
  }
}

async function getNearAccounts(p) {
  assertNotDemo(p.policy_contract);
  assertNotDemo(p.owner_account);
  assertNotDemo(p.agent_account);
  const near = await connectWithAccounts(rpc, CREDS, [
    p.owner_account,
    p.agent_account,
    p.reconciler_account,
  ].filter(Boolean));
  return {
    near,
    owner: await near.account(p.owner_account),
    agent: await near.account(p.agent_account),
    reconciler: p.reconciler_account
      ? await near.account(p.reconciler_account)
      : null,
  };
}

async function boot() {
  rpc = await pickRpc();
  syncProvisionIntoStore();

  agentSvc = createAgentService({
    store,
    getNearAccounts,
    viewFunction: (accountId, method, args) =>
      viewFunction(rpc, accountId, method, args),
    attestor,
    eth,
    logger: console,
  });

  const provision = loadProvision();
  if (provision?.reconciler) {
    assertNotDemo(provision.reconciler);
    const near = await connectWithAccounts(rpc, CREDS, [provision.reconciler]);
    reconSvc = createReconcilerService({
      nearAccount: await near.account(provision.reconciler),
      store,
      logger: console,
    });
  }

  gateJ = createGateJHandlers({
    store,
    evidenceDir: EVIDENCE,
    dataDir: DATA,
    viewFunction: (accountId, method, args = {}) =>
      viewFunction(rpc, accountId, method, args),
    fetchUsdcBalance: async (evm) => {
      const bal = await erc20Balance(USDC_SEPOLIA, evm);
      return String(bal ?? "0");
    },
    fetchEthBalance: async (evm) => String(await ethBalance(evm)),
    fetchIntentsUsdc: async (evm) => intentsMtBalance(rpc, evm),
  });

  const pending = agentSvc.recoverPending();
  writeFileSync(
    join(DATA, "last-boot.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        rpc,
        pending_recoveries: pending.map((p) => p.key),
        attestor_pk: attestor.publicKey,
        gate_j: true,
        note: "no secrets logged",
      },
      null,
      2
    )
  );
  // Evidence mirror (no secrets)
  try {
    writeFileSync(
      join(EVIDENCE, "gate-i-service-boot.json"),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          pending_recoveries: pending.length,
          attestor_pk: attestor.publicKey,
        },
        null,
        2
      )
    );
  } catch {
    /* evidence dir optional in some deploys */
  }
}

async function handle(req, res) {
  if (req.method === "OPTIONS") return json(req, res, 204, {});

  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  let path = url.pathname;
  if (path.startsWith("/v1")) path = path.slice(3) || "/";

  const mutating = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
  // /health is always public; Gate J privileged GETs require API key when configured
  const isHealth = req.method === "GET" && path === "/health";
  const isGateJPublicHealth = req.method === "GET" && path === "/gate-j/health";
  const gateJPrivilegedGet =
    req.method === "GET" &&
    (path === "/gate-j/decisions" || path === "/gate-j/market");
  if (!isHealth && !isGateJPublicHealth) {
    const auth = authorize(req, {
      mutating: mutating || gateJPrivilegedGet,
    });
    if (!auth.ok) return json(req, res, 401, { reason: auth.reason });
  }

  try {
    if (isHealth) {
      return json(req, res, 200, {
        ok: true,
        network: "testnet",
        started_at: startedAt,
        uptime_s: Math.floor((Date.now() - Date.parse(startedAt)) / 1000),
        services: {
          agent: agentSvc?.health(),
          attestor: { ok: true, role: "attestor", publicKey: attestor.publicKey },
          reconciler: reconSvc?.health() || { ok: false, reason: "not_booted" },
          gate_j: { ok: true, dry_run_default: true },
        },
        pending_recoveries: agentSvc?.recoverPending()?.length || 0,
        auth: API_KEY ? "api_key_required_for_mutations" : "open_dev_mode",
      });
    }

    if (path.startsWith("/gate-j")) {
      const body = mutating ? await readBody(req) : {};
      const apiKeyHdr =
        req.headers["x-api-key"] ||
        (String(req.headers.authorization || "").startsWith("Bearer ")
          ? String(req.headers.authorization).slice(7)
          : "");
      const gateJHandled = await handleGateJRoute({
        method: req.method,
        path,
        body,
        json,
        req,
        res,
        handlers: gateJ,
        meta: {
          ip: req.socket?.remoteAddress || "",
          apiKeyHash: apiKeyHdr ? `k${apiKeyHdr.length}` : "none",
        },
      });
      if (gateJHandled) return;
      return json(req, res, 404, { reason: "unknown_gate_j_route", path });
    }

    if (req.method === "POST" && path === "/portfolios") {
      const body = await readBody(req);
      if (String(body.owner_account || "").startsWith(DEMO_PREFIX)) {
        return json(req, res, 400, {
          status: "blocked",
          reason:
            "demo Ledger owner accounts cannot be used for Gate I onboarding",
        });
      }
      syncProvisionIntoStore();
      const match = Object.values(store.read().portfolios).find(
        (p) => p.owner_account === body.owner_account
      );
      if (match) {
        return json(req, res, 200, {
          status: "ready",
          portfolio: match,
          next_action: "fund_deposit_address",
        });
      }
      return json(req, res, 200, {
        status: "blocked",
        reason:
          "Interactive wallet factory not yet self-serve on this host. Use scripts/gate-i-provision.mjs then connect that owner.",
      });
    }

    const balMatch = path.match(/^\/portfolios\/([^/]+)\/balances$/);
    if (req.method === "GET" && balMatch) {
      const id = decodeURIComponent(balMatch[1]);
      const p = store.getPortfolio(id);
      if (!p) return json(req, res, 404, { reason: "not_found" });
      const evm = p.intents_signer_id;
      const [gas, usdc, intentsUsdc, intentsWnear] = await Promise.all([
        ethBalance(evm),
        erc20Balance(USDC_SEPOLIA, evm),
        intentsMtBalance(rpc, evm),
        intentsMtBalance(
          rpc,
          evm,
          "nep141:wnear.tidepool-sandbox.testnet"
        ),
      ]);
      return json(req, res, 200, [
        {
          chain: "sepolia",
          asset: "ETH",
          amount: gas,
          location: "mpc_evm",
          verification: "live_read",
        },
        {
          chain: "sepolia",
          asset: "USDC",
          amount: usdc,
          location: "mpc_evm",
          verification: "live_read",
        },
        {
          chain: "intents",
          asset: "USDC",
          amount: String(intentsUsdc?.error ? "0" : intentsUsdc),
          location: "intents",
          verification: intentsUsdc?.error ? "unavailable" : "live_read",
        },
        {
          chain: "intents",
          asset: "wNEAR",
          amount: String(intentsWnear?.error ? "0" : intentsWnear),
          location: "intents",
          verification: intentsWnear?.error ? "unavailable" : "live_read",
        },
      ]);
    }

    const getMatch = path.match(/^\/portfolios\/([^/]+)$/);
    if (req.method === "GET" && getMatch) {
      const id = decodeURIComponent(getMatch[1]);
      const p = store.getPortfolio(id);
      if (!p) return json(req, res, 404, { reason: "not_found" });
      return json(req, res, 200, p);
    }

    const depMatch = path.match(/^\/portfolios\/([^/]+)\/deposits$/);
    if (req.method === "POST" && depMatch) {
      const id = decodeURIComponent(depMatch[1]);
      const p = store.getPortfolio(id);
      if (!p) return json(req, res, 404, { reason: "not_found" });
      return json(req, res, 200, {
        portfolio_id: id,
        chain: "sepolia",
        asset: "USDC",
        deposit_address: p.intents_signer_id,
        memo: p.derivation_path,
        status: "awaiting_funds",
      });
    }

    const wq = path.match(/^\/portfolios\/([^/]+)\/withdrawals\/quote$/);
    if (req.method === "POST" && wq) {
      const id = decodeURIComponent(wq[1]);
      const p = store.getPortfolio(id);
      const body = await readBody(req);
      if (!p) {
        return json(req, res, 404, {
          ok: false,
          destination_valid: false,
          requires_owner_signature: true,
          blocked_reason: "not_found",
        });
      }
      const dest = String(body.destination || "").toLowerCase();
      const limits = await viewFunction(rpc, p.policy_contract, "get_limits");
      const allowed = (limits?.allowed_destinations || []).map((d) =>
        String(d).toLowerCase()
      );
      const destination_valid = allowed.includes(dest);
      return json(req, res, 200, {
        ok: destination_valid,
        destination_valid,
        requires_owner_signature: true,
        fee_estimate: "sepolia_gas",
        blocked_reason: destination_valid
          ? undefined
          : "destination_not_allowlisted",
      });
    }

    const wd = path.match(/^\/portfolios\/([^/]+)\/withdrawals$/);
    if (req.method === "POST" && wd) {
      const id = decodeURIComponent(wd[1]);
      const p = store.getPortfolio(id);
      const body = await readBody(req);
      if (!p) return json(req, res, 404, { status: "blocked", reason: "not_found" });
      if (process.env.GATE_I_ALLOW_SERVER_OWNER_SIGN !== "1") {
        return json(req, res, 200, {
          status: "blocked",
          reason:
            "Owner must sign owner_request_withdraw_signature via wallet/Ledger. Server never holds owner keys in production.",
        });
      }
      assertNotDemo(p.owner_account);
      const { owner } = await getNearAccounts(p);
      const nonce = BigInt(
        (await eth("eth_getTransactionCount", [p.intents_signer_id, "pending"]))
          .result
      );
      let gasPrice = BigInt((await eth("eth_gasPrice", [])).result || "0");
      if (gasPrice < 1_000_000_000n) gasPrice = 1_000_000_000n;
      const opId = `api-wd-${Date.now()}`;
      try {
        const tx = await owner.functionCall({
          contractId: p.policy_contract,
          methodName: "owner_request_withdraw_signature",
          args: {
            operation_id: opId,
            withdraw: {
              nonce: nonce.toString(),
              gas_price: gasPrice.toString(),
              gas_limit: "100000",
              chain_id: "11155111",
              token_contract: USDC_SEPOLIA.toLowerCase(),
              to: String(body.destination).toLowerCase(),
              amount: String(body.amount),
            },
          },
          gas: BigInt("300000000000000"),
          attachedDeposit: 1n,
        });
        return json(req, res, 200, {
          status: "submitted",
          tx_hash: tx.transaction.hash,
          explorer_url: `https://testnet.nearblocks.io/txns/${tx.transaction.hash}`,
        });
      } catch (e) {
        return json(req, res, 200, {
          status: "failed",
          reason: String(e.message || e).slice(0, 400),
        });
      }
    }

    const ag = path.match(/^\/portfolios\/([^/]+)\/agent$/);
    if (req.method === "GET" && ag) {
      return json(req, res, 200, agentSvc.state(decodeURIComponent(ag[1])));
    }
    const agStart = path.match(/^\/portfolios\/([^/]+)\/agent\/start$/);
    if (req.method === "POST" && agStart) {
      return json(req, res, 200, agentSvc.start(decodeURIComponent(agStart[1])));
    }
    const agStop = path.match(/^\/portfolios\/([^/]+)\/agent\/stop$/);
    if (req.method === "POST" && agStop) {
      return json(req, res, 200, agentSvc.stop(decodeURIComponent(agStop[1])));
    }

    return json(req, res, 404, { reason: "unknown_route", path });
  } catch (e) {
    console.error("[api]", String(e.message || e).slice(0, 300));
    return json(req, res, 500, { reason: String(e.message || e).slice(0, 300) });
  }
}

await boot();

const TLS_CERT = process.env.GATE_I_TLS_CERT || "";
const TLS_KEY = process.env.GATE_I_TLS_KEY || "";
const TLS_PORT = Number(process.env.GATE_I_TLS_PORT || 8443);
const TLS_ONLY = process.env.GATE_I_TLS_ONLY === "1";

const onListen = (scheme, port) => {
  console.log(
    JSON.stringify({
      listening: `${scheme}://${HOST}:${port}/v1`,
      health: `${scheme}://${HOST}:${port}/v1/health`,
      gate_j_health: `${scheme}://${HOST}:${port}/v1/gate-j/health`,
      attestor_public: attestor.publicKey,
      auth: API_KEY ? "mutations_require_api_key" : "open_dev_mode",
      persistence: DATA,
      tls: scheme === "https",
    })
  );
};

if (!TLS_ONLY) {
  createServer((req, res) => {
    handle(req, res);
  }).listen(PORT, HOST, () => onListen("http", PORT));
}

if (TLS_CERT && TLS_KEY && existsSync(TLS_CERT) && existsSync(TLS_KEY)) {
  createHttpsServer(
    {
      cert: readFileSync(TLS_CERT),
      key: readFileSync(TLS_KEY),
    },
    (req, res) => handle(req, res)
  ).listen(TLS_PORT, HOST, () => onListen("https", TLS_PORT));
} else if (TLS_ONLY) {
  console.error("GATE_I_TLS_ONLY=1 but GATE_I_TLS_CERT/KEY missing");
  process.exit(1);
}
