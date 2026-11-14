#!/usr/bin/env node
/**
 * Continuous autonomous wake loop.
 *
 * Mandate ON-CHAIN = permission. This process = the actual brain waking up.
 * Without this loop, "autonomous" only means the contract would allow a trade
 * if a keeper ran — it does NOT invent decisions by itself.
 *
 * Usage:
 *   node scripts/mainnet/autonomous-wake-loop.mjs
 *   NIO_WAKE_MS=600000 node scripts/mainnet/autonomous-wake-loop.mjs   # 10 min
 *   node scripts/mainnet/autonomous-wake-loop.mjs --once                 # single cycle
 *
 * Env:
 *   NIO_WAKE_MS                 default 600000 (10 minutes)
 *   NIO_DECISION_AUDIT_ON_CHAIN=1  (default on in this script)
 *   NIO_MAINNET_AUTONOMOUS_EXEC=1  allow funded MAINNET exec when TRADE
 *   OPENROUTER_API_KEY / NIO_AGENT_OPS_KEY_PATH  required on host
 */
import { mkdir, writeFile, appendFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { MAINNET_IDENTITIES } from "../../packages/mainnet/identities.mjs";
import { buildMandateV1Draft, validateMandateV1 } from "../../packages/mandate/v1/schema.mjs";
import { runKeeperCycles } from "../../packages/autonomous/keeper.mjs";
import { LLM_MODE } from "../../packages/autonomous/shadowAgent.mjs";
import { EXEC_MODE } from "../../packages/autonomous/executorAdapter.mjs";
import { loadServicesEnv, getLlmConfig } from "../../packages/gate-j/llm.mjs";
import { createDecisionAuditPublisher } from "../../packages/autonomous/auditPublisher.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const EVIDENCE = join(ROOT, "docs", "evidence");
const POLICY = MAINNET_IDENTITIES.policy;
const ONCE = process.argv.includes("--once");
const WAKE_MS = Math.max(
  30_000,
  Number(process.env.NIO_WAKE_MS || process.env.WAKE_MS || 600_000)
);

const RPCS = [
  process.env.NIO_MAINNET_RPC,
  "https://rpc.mainnet.near.org",
  "https://rpc.mainnet.fastnear.com",
].filter(Boolean);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pickRpc() {
  for (const u of RPCS) {
    try {
      const res = await fetch(u, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: [] }),
      });
      if (!(await res.json()).error) return u;
    } catch {
      /* next */
    }
  }
  throw new Error("no_mainnet_rpc");
}

async function viewFn(url, accountId, methodName, args = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: accountId,
        method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const j = await res.json();
  if (j.error || j.result?.error) return { error: j.error || j.result.error };
  return JSON.parse(Buffer.from(j.result.result).toString("utf8"));
}

async function ensureJournalSecret() {
  const dir = join(homedir(), ".nio-secure", "mainnet");
  const path = join(dir, "journal.secret");
  try {
    await access(path);
  } catch {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    const b64 = randomBytes(48)
      .toString("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    writeFileSync(path, b64, { encoding: "utf8", mode: 0o600 });
  }
  process.env.NIO_TX_JOURNAL_SECRET_PATH = path;
  return path;
}

function mandateFromChain(views) {
  const limits = views.get_limits || {};
  const epoch = Number(views.get_mandate_epoch || 0);
  const trading =
    views.get_autonomous_trading === true ||
    String(views.get_autonomous_trading) === "true";
  return buildMandateV1Draft({
    network: "mainnet",
    policy_contract: POLICY,
    owner: MAINNET_IDENTITIES.owner,
    portfolio_id: MAINNET_IDENTITIES.portfolio_id,
    agent_id: MAINNET_IDENTITIES.agent,
    executor_id: MAINNET_IDENTITIES.agent,
    mandate_id: `mainnet-wake-epoch-${epoch}`,
    epoch,
    mandate_epoch: epoch,
    strategy_hash: "nio-live-llm-fitter-v1",
    prompt_version_hash: "nio_autonomous_gate_j_v1",
    created_at_ms: Date.now(),
    expires_at_ms: limits.valid_until
      ? Math.floor(Number(limits.valid_until) / 1e6)
      : Date.now() + 10 * 24 * 3600_000,
    allowed_chains: limits.allowed_chains || ["near", "eip155:1", "eip155:42161", "eip155:8453"],
    allowed_assets: limits.allowed_assets || [],
    allowed_venues: limits.allowed_venues || ["near_intents_1click"],
    allowed_destinations: limits.allowed_destinations || [
      MAINNET_IDENTITIES.owner,
      MAINNET_IDENTITIES.mpc_evm_address,
    ],
    trading_enabled: trading,
    max_trade_raw: String(limits.max_trade_value || "5000000"),
    total_trading_budget_raw: String(limits.daily_turnover_limit || "25000000"),
    daily_turnover_budget_raw: String(limits.daily_turnover_limit || "25000000"),
    max_pending_exposure_raw: String(limits.max_pending_exposure || "10000000"),
    max_slippage_bps: Number(limits.max_slippage_bps || 200),
    max_gas_budget: String(limits.max_gas_budget || "2500000000000000"),
    data_purchase_enabled: false,
    commerce_budget_raw: "0",
    max_marketplace_purchase_raw: "0",
    openrouter_daily_usd_micros: "2000000",
    openrouter_max_requests_per_day: 200,
    limits,
  });
}

async function loadChain(url) {
  const methods = [
    "get_paused",
    "get_autonomous_trading",
    "get_enforce_autonomous_on_agent",
    "get_mandate_epoch",
    "get_limits",
    "get_state_version",
    "get_revocation_status",
  ];
  const views = {};
  for (const m of methods) {
    views[m] = await viewFn(url, POLICY, m);
  }
  return views;
}

async function runOneCycle({ url, auditPublishFn, logPath }) {
  const views = await loadChain(url);
  const paused = views.get_paused === true;
  const autonomous = views.get_autonomous_trading === true;
  const enforce = views.get_enforce_autonomous_on_agent === true;
  const revoked = views.get_revocation_status?.revoked === true;
  const unlock = process.env.NIO_MAINNET_AUTONOMOUS_EXEC === "1";
  const canFunded = unlock && !paused && autonomous && enforce && !revoked;

  if (paused || !autonomous || revoked) {
    const skip = {
      at: new Date().toISOString(),
      skipped: true,
      reason: paused ? "paused" : revoked ? "revoked" : "autonomous_off",
      epoch: views.get_mandate_epoch,
    };
    await appendFile(logPath, JSON.stringify(skip) + "\n");
    console.error(JSON.stringify(skip));
    return skip;
  }

  const mandate = mandateFromChain(views);
  const validation = validateMandateV1(mandate);
  if (!validation.ok) {
    const fail = { at: new Date().toISOString(), ok: false, reason: "mandate_invalid", validation };
    await appendFile(logPath, JSON.stringify(fail) + "\n");
    console.error(JSON.stringify(fail));
    return fail;
  }

  const portfolio_id = process.env.NIO_WAKE_PORTFOLIO_ID || "nio-mainnet-v1";
  const journal_dir = join(homedir(), ".nio-secure", "mainnet-keeper", portfolio_id);

  const result = await runKeeperCycles({
    mandate,
    portfolio_id,
    journal_dir,
    cycles: 1,
    wake_ms: 0,
    llmMode: LLM_MODE.LIVE_LLM,
    liveMarket: true,
    evidence_dir: EVIDENCE,
    execMode: canFunded ? EXEC_MODE.MAINNET : EXEC_MODE.SHADOW,
    execAdapters: null,
    onChain: {
      paused,
      revoked,
      autonomous_trading: autonomous,
      enforce_autonomous_on_agent: enforce,
      mandate_epoch: Number(views.get_mandate_epoch || 0),
      limits: views.get_limits,
    },
    auditPublishFn,
    auditOnChain: true,
  });

  const cycle0 = result.cycles?.[0] || {};
  const summary = {
    at: new Date().toISOString(),
    ok: result.ok,
    epoch: views.get_mandate_epoch,
    action: cycle0.decision?.action || null,
    reason: cycle0.decision?.reason || null,
    fitter: cycle0.decision?.fitter_outcome || null,
    decision_hash: cycle0.decision?.decision_hash || null,
    evidence_hash: cycle0.decision_audit?.evidence_hash || cycle0.audit?.evidence_hash || null,
    near_tx:
      cycle0.decision_audit?.near_tx ||
      cycle0.audit?.near_tx ||
      cycle0.audit?.tx_hash ||
      null,
    audit_status: cycle0.decision_audit?.status || cycle0.audit?.status || null,
    funded_exec_eligible: canFunded,
    wake_ms: WAKE_MS,
  };
  await appendFile(logPath, JSON.stringify(summary) + "\n");
  console.log(JSON.stringify(summary));
  return summary;
}

async function main() {
  loadServicesEnv();
  const llm = getLlmConfig();
  if (!llm.configured) {
    console.error(JSON.stringify({ ok: false, reason: "OPENROUTER_API_KEY_MISSING" }));
    process.exit(1);
  }

  process.env.NIO_DECISION_AUDIT_ON_CHAIN = "1";
  await ensureJournalSecret();
  await mkdir(EVIDENCE, { recursive: true });

  const statusDir = join(homedir(), ".nio-secure", "mainnet-keeper");
  await mkdir(statusDir, { recursive: true });
  const logPath = join(statusDir, "wake-loop.jsonl");
  const statusPath = join(EVIDENCE, "AUTONOMOUS_WAKE_LOOP.json");

  let auditPublishFn = null;
  try {
    const publisher = await createDecisionAuditPublisher({
      opsKeyPath: process.env.NIO_AGENT_OPS_KEY_PATH,
    });
    auditPublishFn = (args) => publisher.publish(args);
  } catch (e) {
    console.error(
      JSON.stringify({
        warn: "audit_publisher_init_failed",
        detail: String(e.message || e).slice(0, 200),
      })
    );
  }

  const url = await pickRpc();
  const boot = {
    kind: "AUTONOMOUS_WAKE_LOOP",
    started_at: new Date().toISOString(),
    wake_ms: WAKE_MS,
    once: ONCE,
    policy: POLICY,
    portfolio_id: process.env.NIO_WAKE_PORTFOLIO_ID || "nio-mainnet-v1",
    audit_on_chain: true,
    mainnet_exec: process.env.NIO_MAINNET_AUTONOMOUS_EXEC === "1",
    llm_configured: true,
    meaning:
      "On-chain autonomous_trading=true is permission. This wake loop is the process that actually calls OpenRouter, Fitters, and optionally anchors decisions.",
  };
  await writeFile(statusPath, JSON.stringify(boot, null, 2));
  console.error(JSON.stringify(boot));

  let n = 0;
  for (;;) {
    n += 1;
    console.error(`\n--- wake #${n} ${new Date().toISOString()} ---`);
    try {
      await runOneCycle({ url, auditPublishFn, logPath });
    } catch (e) {
      const err = {
        at: new Date().toISOString(),
        ok: false,
        error: String(e.message || e).slice(0, 400),
      };
      await appendFile(logPath, JSON.stringify(err) + "\n");
      console.error(JSON.stringify(err));
    }
    if (ONCE) break;
    console.error(`sleep ${WAKE_MS}ms (~${Math.round(WAKE_MS / 60000)} min)`);
    await sleep(WAKE_MS);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
