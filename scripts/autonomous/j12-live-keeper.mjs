#!/usr/bin/env node
/**
 * J12 — real OpenRouter keeper shadow cycles (no mainnet mutation).
 * Usage: node scripts/autonomous/j12-live-keeper.mjs [--cycles=3]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { buildMandateV1Draft, validateMandateV1 } from "../../packages/mandate/v1/schema.mjs";
import { hashMandateV1 } from "../../packages/mandate/v1/compiler.mjs";
import { runKeeperCycles } from "../../packages/autonomous/keeper.mjs";
import { LLM_MODE } from "../../packages/autonomous/shadowAgent.mjs";
import { loadServicesEnv, getLlmConfig } from "../../packages/gate-j/llm.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const cyclesArg = process.argv.find((a) => a.startsWith("--cycles="));
const cycles = cyclesArg ? Number(cyclesArg.split("=")[1]) : 3;
const wakeArg = process.argv.find((a) => a.startsWith("--wake-ms="));
const wake_ms = wakeArg ? Number(wakeArg.split("=")[1]) : 2000;

loadServicesEnv();
const llm = getLlmConfig();
if (!llm.configured) {
  console.error(JSON.stringify({ ok: false, error: "OPENROUTER_API_KEY missing" }));
  process.exit(2);
}

const portfolio_id = `j12_live_${Date.now()}`;
const journal_dir = join(tmpdir(), "nio-j12-keeper", portfolio_id);
const evidence_dir = join(ROOT, "docs", "evidence");
await mkdir(evidence_dir, { recursive: true });

const mandate = buildMandateV1Draft({
  network: "mainnet",
  policy_contract: "policy.nishanthb.near",
  owner: "nishanthb.near",
  portfolio_id,
  agent_id: "agent.nishanthb.near",
  executor_id: "agent.nishanthb.near",
  mandate_id: `j12-${portfolio_id}`,
  epoch: 2,
  strategy_hash: "j12_shadow_strategy_v1",
  prompt_version_hash: "nio_autonomous_gate_j_v1",
  created_at_ms: Date.now(),
  expires_at_ms: Date.now() + 7 * 86400_000,
  allowed_chains: ["near", "eip155:1", "eip155:8453"],
  allowed_assets: [
    "native:near",
    "nep141:usdc.near",
    "eip155:1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  ],
  allowed_venues: ["near_intents_1click"],
  allowed_destinations: ["nishanthb.near"],
  trading_enabled: true,
  max_trade_raw: "5000000", // 5 USDC raw (6 dec) micro preview scale
  total_trading_budget_raw: "20000000",
  daily_turnover_budget_raw: "10000000",
  max_pending_exposure_raw: "10000000",
  max_slippage_bps: 100,
  max_gas_budget: "300000000000000",
  data_purchase_enabled: false,
  commerce_budget_raw: "0",
  max_marketplace_purchase_raw: "0",
  openrouter_daily_usd_micros: "500000", // $0.50
  openrouter_max_requests_per_day: 40,
});

const validation = validateMandateV1(mandate);
if (!validation.ok) {
  console.error(JSON.stringify({ ok: false, validation }, null, 2));
  process.exit(1);
}

const result = await runKeeperCycles({
  mandate,
  portfolio_id,
  journal_dir,
  cycles,
  wake_ms,
  llmMode: LLM_MODE.LIVE_LLM,
  liveMarket: true,
  evidence_dir,
});

const report = {
  kind: "J12_REAL_OPENROUTER_KEEPER",
  mandate_hash: hashMandateV1(mandate),
  llm_models: llm.models,
  llm_configured: true,
  hard_stop: {
    mainnet_mutation: false,
    mpc: false,
    broadcast: false,
    ledger: false,
  },
  ...result,
};

const outPath = join(evidence_dir, "J12_REAL_OPENROUTER_KEEPER.json");
await writeFile(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  ok: report.ok,
  verdict: report.verdict,
  cycles: report.cycles?.map((c) => ({
    index: c.index,
    action: c.decision?.action,
    reason: c.decision?.reason,
    decision_hash: c.decision?.decision_hash,
    fitter: c.decision?.fitter_outcome,
    models: c.decision?.models,
  })),
  integrity_after: report.integrity_after,
  evidence_path: outPath,
  journal_path: report.journal_path,
}, null, 2));

process.exit(report.ok ? 0 : 1);
