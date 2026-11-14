#!/usr/bin/env node
/**
 * One-shot mainnet autonomous demo keeper cycle.
 * LIVE_LLM + live market. NO_TRADE is a valid PASS for the decision layer.
 * Financial MAINNET exec only when:
 *   NIO_MAINNET_AUTONOMOUS_EXEC=1 AND on-chain unpaused + autonomous_trading.
 *
 * Usage:
 *   node scripts/mainnet/autonomous-demo-cycle.mjs
 */
import { mkdir, writeFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { MAINNET_IDENTITIES } from "../../packages/mainnet/identities.mjs";
import { buildMandateV1Draft, validateMandateV1 } from "../../packages/mandate/v1/schema.mjs";
import { hashMandateV1 } from "../../packages/mandate/v1/compiler.mjs";
import { runKeeperCycles } from "../../packages/autonomous/keeper.mjs";
import { LLM_MODE } from "../../packages/autonomous/shadowAgent.mjs";
import { EXEC_MODE } from "../../packages/autonomous/executorAdapter.mjs";
import { loadServicesEnv, getLlmConfig } from "../../packages/gate-j/llm.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const EVIDENCE = join(ROOT, "docs", "evidence");
const POLICY = MAINNET_IDENTITIES.policy;
const J14_CODE_HINT = "J14 autonomy WASM (sha 8BF2AEAF…)";

const RPCS = [
  process.env.NIO_MAINNET_RPC,
  "https://rpc.mainnet.fastnear.com",
  "https://rpc.mainnet.near.org",
].filter(Boolean);

async function pickRpc() {
  for (const u of RPCS) {
    try {
      const res = await fetch(u, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: [] }),
      });
      const j = await res.json();
      if (!j.error) return u;
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
  if (j.error) return { error: j.error };
  if (j.result?.error) return { error: j.result.error };
  const raw = Buffer.from(j.result.result).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function viewAccount(url, accountId) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: {
        request_type: "view_account",
        finality: "final",
        account_id: accountId,
      },
    }),
  });
  const j = await res.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
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
    mandate_id: `mainnet-demo-epoch-${epoch}`,
    epoch,
    mandate_epoch: epoch,
    strategy_hash: "nio-live-llm-fitter-v1",
    prompt_version_hash: "nio_autonomous_gate_j_v1",
    created_at_ms: Date.now(),
    expires_at_ms: limits.valid_until
      ? Math.floor(Number(limits.valid_until) / 1e6)
      : Date.now() + 24 * 3600_000,
    allowed_chains: limits.allowed_chains || ["near", "eip155:1", "eip155:42161", "eip155:8453"],
    allowed_assets: limits.allowed_assets || [],
    allowed_venues: limits.allowed_venues || ["near_intents_1click"],
    allowed_destinations: limits.allowed_destinations || [
      MAINNET_IDENTITIES.owner,
      MAINNET_IDENTITIES.mpc_evm_address,
    ],
    trading_enabled: trading,
    max_trade_raw: String(limits.max_trade_value || "1000000"),
    total_trading_budget_raw: String(limits.daily_turnover_limit || "5000000"),
    daily_turnover_budget_raw: String(limits.daily_turnover_limit || "5000000"),
    max_pending_exposure_raw: String(limits.max_pending_exposure || "2000000"),
    max_slippage_bps: Number(limits.max_slippage_bps || 100),
    max_gas_budget: String(limits.max_gas_budget || "2500000000000000"),
    data_purchase_enabled: false,
    commerce_budget_raw: "0",
    max_marketplace_purchase_raw: "0",
    openrouter_daily_usd_micros: "500000",
    openrouter_max_requests_per_day: 40,
    limits,
  });
}

async function main() {
  await mkdir(EVIDENCE, { recursive: true });
  loadServicesEnv();
  const llm = getLlmConfig();
  const journalSecret = await ensureJournalSecret();
  const url = await pickRpc();
  const acct = await viewAccount(url, POLICY);
  const views = {
    get_paused: await viewFn(url, POLICY, "get_paused"),
    get_mandate_epoch: await viewFn(url, POLICY, "get_mandate_epoch"),
    get_owner: await viewFn(url, POLICY, "get_owner"),
    get_agent: await viewFn(url, POLICY, "get_agent"),
    get_portfolio_id: await viewFn(url, POLICY, "get_portfolio_id"),
    get_autonomous_trading: await viewFn(url, POLICY, "get_autonomous_trading"),
    get_enforce_autonomous_on_agent: await viewFn(
      url,
      POLICY,
      "get_enforce_autonomous_on_agent"
    ),
    get_limits: await viewFn(url, POLICY, "get_limits"),
    get_state_version: await viewFn(url, POLICY, "get_state_version"),
  };

  const methodsPresent = {
    enforce: !views.get_enforce_autonomous_on_agent?.error,
    state_version: !views.get_state_version?.error,
  };
  const upgraded = methodsPresent.enforce && methodsPresent.state_version;
  const paused = views.get_paused === true;
  const autonomous = views.get_autonomous_trading === true;
  const enforce = views.get_enforce_autonomous_on_agent === true;
  const unlock = process.env.NIO_MAINNET_AUTONOMOUS_EXEC === "1";
  const canFunded =
    upgraded && !paused && autonomous && enforce && unlock && llm.configured;

  const mandate = mandateFromChain(views);
  const validation = validateMandateV1(mandate);
  if (!validation.ok) {
    const fail = {
      kind: "AUTONOMOUS_DEMO_CYCLE",
      ok: false,
      verdict: "FAIL",
      reason: "mandate_validation_failed",
      validation,
      chain: { code_hash: acct.code_hash, views },
    };
    await writeFile(
      join(EVIDENCE, "AUTONOMOUS_KEEPER_RUNNING.json"),
      JSON.stringify(fail, null, 2)
    );
    console.log(JSON.stringify(fail, null, 2));
    process.exit(1);
  }

  const onChain = {
    paused,
    revoked: false,
    autonomous_trading: autonomous,
    enforce_autonomous_on_agent: enforce,
    mandate_epoch: Number(views.get_mandate_epoch || 0),
    limits: views.get_limits,
  };

  const portfolio_id = `${MAINNET_IDENTITIES.portfolio_id}-demo-${Date.now()}`;
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
    execAdapters: null, // decision-first; funded adapters attached after mandate+unpause when TRADE
    onChain,
  });

  const cycle0 = result.cycles?.[0] || {};
  const action = cycle0.decision?.action || null;
  const tradeSettled =
    canFunded &&
    cycle0.execution_service?.ok === true &&
    cycle0.execution_service?.reconcile_ok === true;

  const report = {
    kind: "AUTONOMOUS_DEMO_CYCLE",
    started_at: new Date().toISOString(),
    policy: POLICY,
    code_hash: acct.code_hash,
    upgraded,
    expected_upgrade: J14_CODE_HINT,
    chain: {
      paused,
      autonomous_trading: autonomous,
      enforce_autonomous_on_agent: enforce,
      mandate_epoch: views.get_mandate_epoch,
      state_version: views.get_state_version,
      limits: views.get_limits,
    },
    llm_configured: llm.configured,
    llm_models: llm.models,
    journal_secret_path_set: Boolean(process.env.NIO_TX_JOURNAL_SECRET_PATH),
    journal_secret_fingerprint: createHash("sha256")
      .update(String(journalSecret))
      .digest("hex")
      .slice(0, 16),
    unlock_env: unlock,
    funded_exec_eligible: canFunded,
    mandate_hash: hashMandateV1(mandate),
    decision: cycle0.decision || null,
    execution_plan: cycle0.execution_plan || null,
    execution_service: cycle0.execution_service || null,
    keeper: {
      ok: result.ok,
      verdict: result.verdict,
      journal_path: result.journal_path,
    },
    labels: {
      supervised_prior_trades_separate: true,
      prior_ops_note:
        "j8b/m1/m2 canaries were owner-supervised — not autonomous mainnet trades",
      no_trade_is_valid: action === "NO_TRADE" || action === "HOLD",
    },
    gates: {
      AUTONOMOUS_KEEPER_RUNNING:
        result.ok && llm.configured && Boolean(cycle0.decision?.decision_hash)
          ? "PASS"
          : "FAIL",
      AUTONOMOUS_MAINNET_TRADE_SETTLED: tradeSettled
        ? "PASS"
        : action === "NO_TRADE" || action === "HOLD"
          ? "N/A_NO_TRADE"
          : canFunded
            ? "FAIL"
            : "BLOCKED_PRECONDITIONS",
      DEMO_READY:
        upgraded && !paused && autonomous && enforce && result.ok
          ? tradeSettled || action === "NO_TRADE" || action === "HOLD"
            ? "PASS"
            : "PARTIAL"
          : "BLOCKED",
    },
    blockers: [
      !upgraded && "MAINNET_WASM_NOT_UPGRADED",
      paused && "POLICY_PAUSED",
      !autonomous && "AUTONOMOUS_TRADING_FALSE",
      !enforce && "ENFORCE_AUTONOMOUS_FALSE",
      !unlock && "NIO_MAINNET_AUTONOMOUS_EXEC_NOT_SET",
      !llm.configured && "OPENROUTER_API_KEY_MISSING",
    ].filter(Boolean),
  };

  await writeFile(
    join(EVIDENCE, "AUTONOMOUS_KEEPER_RUNNING.json"),
    JSON.stringify(report, null, 2)
  );
  await writeFile(
    join(EVIDENCE, "DEMO_READY.json"),
    JSON.stringify(
      {
        kind: "DEMO_READY",
        verdict: report.gates.DEMO_READY,
        gates: report.gates,
        blockers: report.blockers,
        decision_hash: cycle0.decision?.decision_hash || null,
        action,
        code_hash: acct.code_hash,
        finished_at: new Date().toISOString(),
      },
      null,
      2
    )
  );

  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        gates: report.gates,
        blockers: report.blockers,
        action,
        decision_hash: cycle0.decision?.decision_hash,
        reason: cycle0.decision?.reason,
        fitter: cycle0.decision?.fitter_outcome,
        evidence: join(EVIDENCE, "AUTONOMOUS_KEEPER_RUNNING.json"),
      },
      null,
      2
    )
  );

  process.exit(result.ok && llm.configured ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
