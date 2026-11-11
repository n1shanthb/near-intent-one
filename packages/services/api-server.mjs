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
import { createGateKHandlers, handleGateKRoute } from "./gate-k-routes.mjs";
import {
  createOwnerAuth,
  openOwnerAuthStore,
} from "./ownerAuth.mjs";
import { createPortfolioProvision } from "./portfolioProvision.mjs";
import { createWithdrawLifecycle } from "./withdrawLifecycle.mjs";
import { createSettlementWorker } from "./settlementWorker.mjs";
import {
  authorizeService,
  authorizePortfolioOwner,
  allowOpenDevMode,
} from "./apiAuth.mjs";
import { openTxJournal } from "../execution/txJournal.mjs";
import { SEPOLIA_TIDEPOOL } from "../execution/chainProfiles.mjs";
import { nearRpc } from "../../scripts/lib/near-live.mjs";
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
const OWNER_AUTH_SECRET =
  process.env.NIO_OWNER_AUTH_SECRET || API_KEY || "nio-owner-auth-dev-only";
const CORS_ORIGINS = (process.env.GATE_I_CORS_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (NETWORK !== "testnet") {
  console.error("refusing to start: NEAR_NETWORK must be testnet");
  process.exit(1);
}

if (!API_KEY && !allowOpenDevMode(process.env, { remoteAddress: "127.0.0.1" })) {
  console.error(
    "refusing to start: GATE_I_API_KEY required (set GATE_I_ALLOW_OPEN_DEV=1 only for localhost/test)"
  );
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
let gateK;
let ownerAuth;
let portfolioProvision;
let withdrawLifecycle;
let settlementWorker;
let txJournal = null;
const startedAt = new Date().toISOString();

async function listNearAccessKeys(accountId) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "nio-owner-auth",
      method: "query",
      params: {
        request_type: "view_access_key_list",
        finality: "final",
        account_id: accountId,
      },
    }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || "rpc_error");
  return j.result?.keys || [];
}

function ownerSessionFromReq(req) {
  const hdr =
    req.headers["x-nio-owner-session"] ||
    (String(req.headers.authorization || "").startsWith("Owner ")
      ? String(req.headers.authorization).slice(6).trim()
      : "");
  if (!hdr || !ownerAuth) return { ok: false, reason: "owner_session_required" };
  return ownerAuth.resolveSession(hdr);
}

function listOwnerPortfolios(req, res, jsonFn) {
  const sess = ownerSessionFromReq(req);
  if (!sess.ok) return jsonFn(req, res, 401, sess);
  syncProvisionIntoStore();
  const all = Object.values(store.read().portfolios || {});
  const mine = all.filter(
    (p) => String(p.owner_account) === String(sess.account_id)
  );
  const ready = mine.filter((p) => p.deploy_status === "ready");
  const pending = mine.filter((p) => p.deploy_status !== "ready");
  return jsonFn(req, res, 200, {
    ok: true,
    owner_account: sess.account_id,
    portfolios: mine,
    ready,
    pending,
    ui: {
      state: ready.length
        ? "ready"
        : pending.length
          ? "awaiting_provision"
          : "no_portfolio",
      next_action: ready.length
        ? "fund_deposit_address"
        : pending.length
          ? "wait_or_register_policy"
          : "request_provision_or_register",
    },
  });
}

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
    "access-control-allow-headers":
      "content-type, authorization, x-api-key, x-nio-owner-session",
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

/** Mutating routes require API key; open_dev only on localhost/test with explicit flag. */
function authorize(req, { mutating }) {
  return authorizeService(req, { mutating, apiKey: API_KEY, env: process.env });
}

function requirePortfolioOwnerSession(req, portfolioId, { requireReady = false } = {}) {
  const sess = ownerSessionFromReq(req);
  syncProvisionIntoStore();
  const portfolio = store.getPortfolio(portfolioId);
  return authorizePortfolioOwner({
    portfolioId,
    portfolio,
    session: sess,
    requireReady,
  });
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

  ownerAuth = createOwnerAuth({
    store: openOwnerAuthStore(DATA),
    secret: OWNER_AUTH_SECRET,
    network: NETWORK,
    listAccessKeys: listNearAccessKeys,
  });

  const viewFnBoot = (accountId, method, args = {}) =>
    viewFunction(rpc, accountId, method, args);

  portfolioProvision = createPortfolioProvision({
    store,
    viewFunction: viewFnBoot,
    selfProvisionEnabled: process.env.GATE_I_SELF_PROVISION === "1",
  });
  withdrawLifecycle = createWithdrawLifecycle({ store });

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

  const viewFn = (accountId, method, args = {}) =>
    viewFunction(rpc, accountId, method, args);
  const fetchUsdcBalance = async (evm) => {
    const bal = await erc20Balance(USDC_SEPOLIA, evm);
    return String(bal ?? "0");
  };
  const fetchEthBalance = async (evm) => String(await ethBalance(evm));
  const fetchIntentsUsdc = async (evm) => intentsMtBalance(rpc, evm);

  gateJ = createGateJHandlers({
    store,
    evidenceDir: EVIDENCE,
    dataDir: DATA,
    viewFunction: viewFn,
    fetchUsdcBalance,
    fetchEthBalance,
    fetchIntentsUsdc,
  });

  // Durable journal — required before any live broadcast (testnet or mainnet).
  const journalPath =
    process.env.NIO_TX_JOURNAL_PATH || join(DATA, "tx-journal.sqlite");
  const journalSecret =
    process.env.NIO_TX_JOURNAL_SECRET ||
    process.env.NIO_OWNER_AUTH_SECRET ||
    API_KEY ||
    "nio-journal-dev-only";
  try {
    txJournal = openTxJournal({ path: journalPath, secret: journalSecret });
    txJournal.assertWritable();
  } catch (e) {
    console.error("[boot] tx journal unavailable:", String(e.message || e).slice(0, 200));
    txJournal = null;
  }

  gateK = createGateKHandlers({
    store,
    evidenceDir: EVIDENCE,
    dataDir: DATA,
    viewFunction: viewFn,
    fetchUsdcBalance,
    fetchEthBalance,
    fetchIntentsUsdc,
    getNearAccounts,
    attestor,
    eth,
    journal: txJournal,
    profile: SEPOLIA_TIDEPOOL,
    reconcilerHealth: () => reconSvc?.health() || { ok: false, reason: "not_booted" },
  });

  // Settlement worker default OFF — never auto-broadcast without explicit env.
  // Profile remains Sepolia/Tidepool for this testnet-locked API server.
  settlementWorker = createSettlementWorker({
    store,
    eth,
    nearRpc,
    rpcUrl: rpc,
    viewFunction: viewFn,
    reconciler: reconSvc,
    journal: txJournal,
    profile: SEPOLIA_TIDEPOOL,
    logger: console,
    enabled: process.env.GATE_K_SETTLEMENT_WORKER === "1",
    dryRun: process.env.GATE_K_SETTLEMENT_DRY_RUN !== "0",
    intervalMs: Number(process.env.GATE_K_SETTLEMENT_INTERVAL_MS || 30000),
  });
  if (process.env.GATE_K_SETTLEMENT_WORKER === "1") {
    if (!txJournal) {
      console.error("[boot] refusing to start settlement worker without durable journal");
    } else {
      settlementWorker.start();
    }
  }

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
  const isGateJDemoStatus =
    req.method === "GET" && path === "/gate-j/demo-status";
  const isGateKPublicHealth = req.method === "GET" && path === "/gate-k/health";
  const isOwnerAuthPublic =
    (req.method === "POST" &&
      (path === "/owner/challenge" || path === "/owner/verify")) ||
    (req.method === "GET" &&
      (path === "/owner/session" ||
        path === "/owner/portfolios" ||
        path === "/owner/provision-requests" ||
        path === "/portfolios/mine")) ||
    (req.method === "POST" && path === "/owner/logout");
  const gateJPrivilegedGet =
    req.method === "GET" &&
    (path === "/gate-j/decisions" || path === "/gate-j/market");
  const gateKPrivilegedGet =
    req.method === "GET" &&
    (path === "/gate-k/decisions" ||
      path === "/gate-k/autonomous" ||
      path === "/gate-k/pending");
  if (
    !isHealth &&
    !isGateJPublicHealth &&
    !isGateJDemoStatus &&
    !isGateKPublicHealth &&
    !isOwnerAuthPublic
  ) {
    const auth = authorize(req, {
      mutating: mutating || gateJPrivilegedGet || gateKPrivilegedGet,
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
          gate_k: gateK?.health() || { ok: false },
          settlement_worker: settlementWorker?.health() || { ok: false },
        },
        pending_recoveries: agentSvc?.recoverPending()?.length || 0,
        auth: API_KEY
          ? "api_key_required_for_mutations"
          : allowOpenDevMode(process.env)
            ? "open_dev_localhost_only"
            : "api_key_required",
        owner_auth: "nep413",
        agent_control: "owner_session_required",
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
          realIp: String(req.headers["x-real-ip"] || ""),
          forwardedFor: String(req.headers["x-forwarded-for"] || ""),
          xForwardedFor: String(req.headers["x-forwarded-for"] || ""),
          apiKeyHash: apiKeyHdr ? `k${apiKeyHdr.length}` : "none",
          authenticated: !API_KEY || apiKeyHdr === API_KEY,
        },
      });
      if (gateJHandled) return;
      return json(req, res, 404, { reason: "unknown_gate_j_route", path });
    }

    if (path.startsWith("/gate-k")) {
      const isGateKPublicHealth = req.method === "GET" && path === "/gate-k/health";
      const body = mutating ? await readBody(req) : {};
      const apiKeyHdr =
        req.headers["x-api-key"] ||
        (String(req.headers.authorization || "").startsWith("Bearer ")
          ? String(req.headers.authorization).slice(7)
          : "");
      const authenticated = !API_KEY || apiKeyHdr === API_KEY;
      if (!isGateKPublicHealth && mutating && API_KEY && !authenticated) {
        return json(req, res, 401, { reason: "unauthorized" });
      }
      const gateKHandled = await handleGateKRoute({
        method: req.method,
        path,
        body,
        json,
        req,
        res,
        handlers: gateK,
        meta: {
          ip: req.socket?.remoteAddress || "",
          apiKeyHash: apiKeyHdr ? `k${apiKeyHdr.length}` : "none",
          authenticated,
          ownerSession: ownerSessionFromReq(req),
        },
      });
      if (gateKHandled) return;
      return json(req, res, 404, { reason: "unknown_gate_k_route", path });
    }

    if (path.startsWith("/owner")) {
      if (req.method === "POST" && path === "/owner/challenge") {
        const body = await readBody(req);
        const out = ownerAuth.issueChallenge({
          account_id: body.account_id,
          domain: body.domain,
        });
        return json(req, res, out.ok ? 200 : 400, out);
      }
      if (req.method === "POST" && path === "/owner/verify") {
        const body = await readBody(req);
        const out = await ownerAuth.verifyChallenge({
          challenge_id: body.challenge_id,
          account_id: body.account_id,
          public_key: body.public_key,
          signature: body.signature,
          domain: body.domain,
        });
        return json(req, res, out.ok ? 200 : 401, out);
      }
      if (req.method === "GET" && path === "/owner/session") {
        const sess = ownerSessionFromReq(req);
        return json(req, res, sess.ok ? 200 : 401, sess);
      }
      if (req.method === "POST" && path === "/owner/logout") {
        const hdr = req.headers["x-nio-owner-session"] || "";
        const out = ownerAuth.revokeSession(hdr);
        return json(req, res, out.ok ? 200 : 401, out);
      }
      if (req.method === "GET" && path === "/owner/portfolios") {
        return listOwnerPortfolios(req, res, json);
      }
      if (req.method === "GET" && path === "/owner/provision-requests") {
        const sess = ownerSessionFromReq(req);
        if (!sess.ok) return json(req, res, 401, sess);
        const reqs = Object.values(store.read().provision_requests || {}).filter(
          (r) => String(r.owner_account) === String(sess.account_id)
        );
        return json(req, res, 200, {
          ok: true,
          owner_account: sess.account_id,
          requests: reqs,
        });
      }
      return json(req, res, 404, { reason: "unknown_owner_route", path });
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
      const sess = ownerSessionFromReq(req);
      if (!sess.ok) {
        return json(req, res, 401, {
          status: "blocked",
          reason: "owner_session_required",
          detail:
            "Authenticate via POST /v1/owner/challenge + /v1/owner/verify before portfolio actions. claimed_owner is not authentication.",
        });
      }
      if (String(body.owner_account || "") !== String(sess.account_id)) {
        return json(req, res, 403, {
          status: "blocked",
          reason: "owner_account_mismatch",
        });
      }
      syncProvisionIntoStore();
      const action = String(body.action || "create");
      if (action === "lookup" || action === "status") {
        syncProvisionIntoStore();
        const mine = Object.values(store.read().portfolios || {}).filter(
          (p) => String(p.owner_account) === String(sess.account_id)
        );
        const ready = mine.find((p) => p.deploy_status === "ready") || null;
        const pending = mine.filter((p) => p.deploy_status !== "ready");
        return json(req, res, 200, {
          ok: true,
          status: ready
            ? "ready"
            : pending.length
              ? "awaiting_provision"
              : "no_portfolio",
          portfolio: ready,
          pending_portfolios: pending,
          deposit_address: ready?.intents_signer_id || null,
          derivation_path: ready?.derivation_path || null,
          owner_authenticated: true,
          next_action: ready
            ? "fund_deposit_address"
            : pending.length
              ? "wait_or_register_policy"
              : "request_provision_or_register",
        });
      }
      if (action === "register") {
        const out = await portfolioProvision.registerExisting({
          owner_account: body.owner_account,
          policy_contract: body.policy_contract,
          portfolio_id: body.portfolio_id || null,
        });
        return json(req, res, out.ok ? 200 : 400, out);
      }
      if (action === "request_provision" || action === "create") {
        const match = Object.values(store.read().portfolios).find(
          (p) =>
            p.owner_account === body.owner_account && p.deploy_status === "ready"
        );
        if (match) {
          return json(req, res, 200, {
            ok: true,
            status: "ready",
            portfolio: match,
            next_action: "fund_deposit_address",
            owner_authenticated: true,
          });
        }
        const out = portfolioProvision.requestProvision({
          owner_account: body.owner_account,
          notes: body.notes || null,
        });
        return json(req, res, 200, { ...out, owner_authenticated: true });
      }
      return json(req, res, 400, {
        status: "blocked",
        reason: "unknown_portfolio_action",
        allowed: [
          "lookup",
          "status",
          "register",
          "request_provision",
          "create",
        ],
      });
    }

    const balMatch = path.match(/^\/portfolios\/([^/]+)\/balances$/);
    if (req.method === "GET" && balMatch) {
      const id = decodeURIComponent(balMatch[1]);
      const p = store.getPortfolio(id);
      if (!p) return json(req, res, 404, { reason: "not_found" });
      // Personal portfolios require owner session; demo/first-test IDs stay readable for BFF
      const isDemoOrFirst =
        String(p.owner_account || "").startsWith(DEMO_PREFIX) ||
        id === "i-a-a4e7" ||
        id === "i-b-a4e7";
      if (!isDemoOrFirst) {
        const sess = ownerSessionFromReq(req);
        if (!sess.ok || String(sess.account_id) !== String(p.owner_account)) {
          return json(req, res, 401, { reason: "owner_session_required" });
        }
      }
      if (!p.intents_signer_id) {
        return json(req, res, 200, {
          ok: false,
          status: "awaiting_provision",
          balances: [],
          reason: "deposit_address_not_ready",
        });
      }
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

    if (req.method === "GET" && path === "/portfolios/mine") {
      return listOwnerPortfolios(req, res, json);
    }

    const getMatch = path.match(/^\/portfolios\/([^/]+)$/);
    if (req.method === "GET" && getMatch) {
      const id = decodeURIComponent(getMatch[1]);
      const p = store.getPortfolio(id);
      if (!p) return json(req, res, 404, { reason: "not_found" });
      const isDemoOrFirst =
        String(p.owner_account || "").startsWith(DEMO_PREFIX) ||
        id === "i-a-a4e7" ||
        id === "i-b-a4e7";
      if (!isDemoOrFirst) {
        const sess = ownerSessionFromReq(req);
        if (!sess.ok || String(sess.account_id) !== String(p.owner_account)) {
          return json(req, res, 401, {
            reason: "owner_session_required",
            detail: "Personal portfolio reads require matching owner session",
          });
        }
      }
      return json(req, res, 200, p);
    }

    const depMatch = path.match(/^\/portfolios\/([^/]+)\/deposits$/);
    if (req.method === "POST" && depMatch) {
      const id = decodeURIComponent(depMatch[1]);
      const p = store.getPortfolio(id);
      if (!p) return json(req, res, 404, { reason: "not_found" });
      const isDemoOrFirst =
        String(p.owner_account || "").startsWith(DEMO_PREFIX) ||
        id === "i-a-a4e7" ||
        id === "i-b-a4e7";
      if (!isDemoOrFirst) {
        const sess = ownerSessionFromReq(req);
        if (!sess.ok || String(sess.account_id) !== String(p.owner_account)) {
          return json(req, res, 401, { reason: "owner_session_required" });
        }
      }
      if (!p.intents_signer_id) {
        return json(req, res, 200, {
          portfolio_id: id,
          status: "awaiting_provision",
          reason: "deposit_address_not_ready",
          derivation_path_expected: `trading/v1/portfolio/${id}`,
        });
      }
      const expectedPath = `trading/v1/portfolio/${id}`;
      const pathOk =
        !p.derivation_path || String(p.derivation_path) === expectedPath;
      return json(req, res, 200, {
        portfolio_id: id,
        chain: "sepolia",
        asset: "USDC",
        deposit_address: p.intents_signer_id,
        memo: p.derivation_path,
        derivation_path: p.derivation_path,
        derivation_path_ok: pathOk,
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
      const sess = ownerSessionFromReq(req);
      if (!sess.ok || String(sess.account_id) !== String(p.owner_account)) {
        return json(req, res, 401, {
          ok: false,
          destination_valid: false,
          requires_owner_signature: true,
          blocked_reason: "owner_session_required",
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

    const wdGet = path.match(/^\/portfolios\/([^/]+)\/withdrawals\/([^/]+)$/);
    if (req.method === "GET" && wdGet) {
      const id = decodeURIComponent(wdGet[1]);
      const wid = decodeURIComponent(wdGet[2]);
      const p = store.getPortfolio(id);
      const sess = ownerSessionFromReq(req);
      if (!p) return json(req, res, 404, { reason: "not_found" });
      if (!sess.ok || String(sess.account_id) !== String(p.owner_account)) {
        return json(req, res, 401, { reason: "owner_session_required" });
      }
      const w = withdrawLifecycle.get(wid);
      if (!w || w.portfolio_id !== id) {
        return json(req, res, 404, { reason: "withdraw_not_found" });
      }
      return json(req, res, 200, { ok: true, withdraw: w });
    }

    const wd = path.match(/^\/portfolios\/([^/]+)\/withdrawals$/);
    if (req.method === "POST" && wd) {
      const id = decodeURIComponent(wd[1]);
      const p = store.getPortfolio(id);
      const body = await readBody(req);
      if (!p) return json(req, res, 404, { status: "blocked", reason: "not_found" });
      const sess = ownerSessionFromReq(req);
      if (!sess.ok || String(sess.account_id) !== String(p.owner_account)) {
        return json(req, res, 401, {
          status: "blocked",
          reason: "owner_session_required",
        });
      }

      // Attach already-signed NEAR tx (Ledger/wallet) into lifecycle tracker
      if (body.near_tx_hash && body.withdraw_id) {
        const attached = withdrawLifecycle.attachOwnerTx({
          withdraw_id: body.withdraw_id,
          owner_account: sess.account_id,
          near_tx_hash: body.near_tx_hash,
        });
        return json(req, res, attached.ok ? 200 : 400, attached);
      }

      // Prepare hardware-authorized withdraw (no server signing)
      if (process.env.GATE_I_ALLOW_SERVER_OWNER_SIGN !== "1") {
        const prepared = withdrawLifecycle.prepare({
          portfolio: p,
          owner_account: sess.account_id,
          destination: body.destination,
          amount: body.amount,
          session_id: sess.session_id,
        });
        return json(req, res, prepared.ok ? 200 : 400, {
          ...prepared,
          owner_authenticated: true,
          server_owner_sign: false,
          ecdsa_recall_limitation:
            "Already-exported EVM signatures cannot be recalled by revoking the NEAR mandate.",
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
      const pid = decodeURIComponent(ag[1]);
      const gate = requirePortfolioOwnerSession(req, pid);
      if (!gate.ok) return json(req, res, 401, gate);
      return json(req, res, 200, agentSvc.state(pid));
    }
    const agStart = path.match(/^\/portfolios\/([^/]+)\/agent\/start$/);
    if (req.method === "POST" && agStart) {
      const pid = decodeURIComponent(agStart[1]);
      const gate = requirePortfolioOwnerSession(req, pid, { requireReady: true });
      if (!gate.ok) {
        return json(req, res, gate.reason === "unknown_portfolio" ? 404 : 401, gate);
      }
      return json(req, res, 200, {
        ...agentSvc.start(pid),
        owner_authenticated: true,
        owner_account: gate.account_id,
      });
    }
    const agStop = path.match(/^\/portfolios\/([^/]+)\/agent\/stop$/);
    if (req.method === "POST" && agStop) {
      const pid = decodeURIComponent(agStop[1]);
      const gate = requirePortfolioOwnerSession(req, pid);
      if (!gate.ok) {
        return json(req, res, gate.reason === "unknown_portfolio" ? 404 : 401, gate);
      }
      return json(req, res, 200, {
        ...agentSvc.stop(pid),
        owner_authenticated: true,
        owner_account: gate.account_id,
      });
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
      gate_k_health: `${scheme}://${HOST}:${port}/v1/gate-k/health`,
      attestor_public: attestor.publicKey,
      auth: API_KEY
        ? "mutations_require_api_key"
        : allowOpenDevMode(process.env)
          ? "open_dev_localhost_only"
          : "api_key_required",
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
