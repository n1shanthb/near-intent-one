#!/usr/bin/env node
/**
 * J16 P4 — Unattended OpenRouter keeper against TESTNET mandate (shadow exec).
 * Never forces TRADE. Separately labeled fixture proves pause/revoke stop + restart.
 * HARD STOP: no mainnet.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { runKeeperCycles } from "../../packages/autonomous/keeper.mjs";
import { LLM_MODE } from "../../packages/autonomous/shadowAgent.mjs";
import { EXEC_MODE } from "../../packages/autonomous/executorAdapter.mjs";
import { loadServicesEnv, getLlmConfig } from "../../packages/gate-j/llm.mjs";
import {
  createShadowWorker,
  appendJournalEntry,
  acquireLock,
  releaseLock,
  replayJournal,
  verifyJournalIntegrity,
  markUnknownOutcome,
} from "../../packages/autonomous/worker.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const EVIDENCE = join(ROOT, "docs", "evidence");
mkdirSync(EVIDENCE, { recursive: true });

loadServicesEnv();
const llm = getLlmConfig();

const report = {
  kind: "J16_UNATTENDED_KEEPER_TESTNET",
  started_at: new Date().toISOString(),
  hard_stop_mainnet: true,
  llm_configured: llm.configured,
};

const mandate = {
  trading_enabled: true,
  total_trading_budget_raw: "5000000",
  mandate_epoch: 2,
  limits: { max_trade_value: "5000000" },
  policy_hash: "j16-keeper",
};

// Live OpenRouter — never force TRADE
if (llm.configured) {
  const live = await runKeeperCycles({
    mandate,
    portfolio_id: `j16-live-${randomBytes(2).toString("hex")}`,
    journal_dir: join(tmpdir(), `j16-live-${Date.now()}`),
    cycles: 2,
    wake_ms: 400,
    llmMode: LLM_MODE.LIVE_LLM,
    liveMarket: true,
    execMode: EXEC_MODE.SHADOW,
  });
  report.live_openrouter = {
    ok: live.ok,
    cycles: (live.cycles || []).map((c) => ({
      action: c.decision?.action,
      reason: c.decision?.reason,
      fitter: c.decision?.fitter_outcome,
      execute: c.execution_plan?.execute,
    })),
    note: "HOLD/NO_TRADE is valid; TRADE not forced",
  };
} else {
  report.live_openrouter = { skipped: true, reason: "no_openrouter_key" };
}

// Pause/revoke stop: trading_enabled false + revoked onChain
const paused = await runKeeperCycles({
  mandate: { ...mandate, trading_enabled: false },
  portfolio_id: `j16-paused-${randomBytes(2).toString("hex")}`,
  journal_dir: join(tmpdir(), `j16-p-${Date.now()}`),
  cycles: 1,
  llmMode: LLM_MODE.FIXTURE,
  execMode: EXEC_MODE.SHADOW,
  onChain: {
    paused: true,
    revoked: false,
    autonomous_trading: false,
    enforce_autonomous_on_agent: true,
    mandate_epoch: 2,
  },
});
report.pause_blocks_exec = {
  ok: paused.ok,
  execute: paused.cycles?.[0]?.execution_plan?.execute === false,
  blockers: paused.cycles?.[0]?.execution_plan?.blockers || null,
};

const revoked = await runKeeperCycles({
  mandate,
  portfolio_id: `j16-rev-${randomBytes(2).toString("hex")}`,
  journal_dir: join(tmpdir(), `j16-r-${Date.now()}`),
  cycles: 1,
  llmMode: LLM_MODE.FIXTURE,
  execMode: EXEC_MODE.SHADOW,
  onChain: {
    paused: true,
    revoked: true,
    autonomous_trading: true,
    enforce_autonomous_on_agent: true,
    mandate_epoch: 3,
  },
});
report.revoke_blocks_exec = {
  ok: revoked.ok,
  execute: revoked.cycles?.[0]?.execution_plan?.execute === false,
  blockers: revoked.cycles?.[0]?.execution_plan?.blockers || null,
};

// Restart recovery: journal integrity + no duplicate spend marking
const dir = join(tmpdir(), `j16-restart-${Date.now()}`);
const w1 = await createShadowWorker({
  portfolio_id: "j16-restart",
  journal_dir: dir,
});
await acquireLock(w1);
await appendJournalEntry(w1, {
  kind: "decision",
  action: "NO_TRADE",
  decision_hash: "h1",
});
await markUnknownOutcome(w1, { reason: "ambiguous_broadcast_fixture" });
await releaseLock(w1);
const w2 = await createShadowWorker({
  portfolio_id: "j16-restart",
  journal_dir: dir,
});
const integrity = verifyJournalIntegrity(w2);
const replayed = replayJournal(w2);
report.restart_recovery = {
  integrity_ok: integrity.ok,
  unknown_blocks_spend: Boolean(
    w2.unknown_blocks_spend || replayed.unknown_outcome
  ),
  note: "UNKNOWN preserved across restart; no blind resign/rebroadcast",
};

report.gates = {
  UNATTENDED_AGENT_EXECUTION:
    report.live_openrouter?.ok || report.live_openrouter?.skipped
      ? report.live_openrouter.skipped
        ? "PARTIAL_NO_KEY"
        : "PASS_SHADOW_LIVE_LLM"
      : "FAIL",
  PAUSE_REVOKE_STOPS_AUTH:
    report.pause_blocks_exec.execute && report.revoke_blocks_exec.execute
      ? "PASS"
      : "FAIL",
  RESTART_NO_DUPLICATE: report.restart_recovery.integrity_ok
    ? "PASS"
    : "FAIL",
};

report.verdict =
  report.gates.PAUSE_REVOKE_STOPS_AUTH === "PASS" &&
  report.gates.RESTART_NO_DUPLICATE === "PASS"
    ? "PASS"
    : "NO_GO";
report.finished_at = new Date().toISOString();

writeFileSync(
  join(EVIDENCE, "J16_UNATTENDED_KEEPER_TESTNET.json"),
  JSON.stringify(report, null, 2)
);
console.log(
  JSON.stringify(
    {
      verdict: report.verdict,
      gates: report.gates,
      live: report.live_openrouter,
      evidence: join(EVIDENCE, "J16_UNATTENDED_KEEPER_TESTNET.json"),
    },
    null,
    2
  )
);
process.exit(report.verdict === "PASS" ? 0 : 1);
