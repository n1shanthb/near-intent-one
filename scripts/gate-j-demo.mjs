#!/usr/bin/env node
/**
 * Gate J demo — fixture ALLOWED / ADAPTED / REJECTED evidence + optional live OpenRouter LLM.
 * Dry-run only. Does not broadcast Sepolia or call NEAR MPC.
 *
 *   node scripts/gate-j-demo.mjs
 *   node scripts/gate-j-demo.mjs --live-llm   # requires OPENROUTER_API_KEY
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runGateJPipeline,
  scenarioAllowed,
  scenarioAdapted,
  scenarioRejected,
  getLlmConfig,
  loadServicesEnv,
  resetSpendState,
  baseMandate,
} from "../packages/gate-j/index.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = join(ROOT, "evidence", "live");
mkdirSync(EVIDENCE, { recursive: true });

loadServicesEnv();
const liveLlm = process.argv.includes("--live-llm");

function sanitizeTrace(obj) {
  const s = JSON.stringify(obj, (k, v) => {
    if (/api[_-]?key|authorization|secret|sk-or-/i.test(String(k))) return "[redacted]";
    if (typeof v === "string" && /sk-or-v1-[a-z0-9]+/i.test(v)) return "[redacted]";
    return v;
  });
  return JSON.parse(s);
}

async function runScenario(fn) {
  const s = fn();
  const trace = await runGateJPipeline({
    mandate: s.mandate,
    fixtureProposal: s.proposal,
    marketFixture: s.market,
    criticFixture: s.critic,
    useLlm: false,
    dryRun: true,
    allowExecute: false,
  });
  return { scenario: s.id, summary: trace.summary, trace };
}

async function main() {
  const out = {
    gate: "J",
    dry_run: true,
    created_at: new Date().toISOString(),
    llm: getLlmConfig(),
    note: "Fixture scenarios are deterministic. Live LLM evidence is separate and labeled.",
    scenarios: {},
  };

  for (const fn of [scenarioAllowed, scenarioAdapted, scenarioRejected]) {
    const r = await runScenario(fn);
    out.scenarios[r.scenario] = {
      fitter_outcome: r.summary.fitter_outcome,
      critic_verdict: r.summary.critic_verdict,
      final_decision: r.summary.final_decision,
      may_sign: r.summary.may_sign,
      operation_id: r.summary.operation_id,
      fitted_size: r.trace.fitter_after_critic?.fitted_proposal?.proposed_size_usdc_raw || null,
      reason_codes: r.trace.fitter_after_critic?.reason_codes || [],
    };
    writeFileSync(
      join(EVIDENCE, `gate-j-${r.scenario.toLowerCase()}.json`),
      JSON.stringify(r.trace, null, 2)
    );
    console.log(r.scenario, r.summary.fitter_outcome, r.summary.final_decision);
  }

  writeFileSync(join(EVIDENCE, "gate-j-scenarios.json"), JSON.stringify(out, null, 2));

  if (liveLlm) {
    const cfg = getLlmConfig();
    if (!cfg.configured) {
      console.error(
        "No OPENROUTER_API_KEY — set it in packages/services/.env (GATE_J_LLM_PROVIDER=openrouter)"
      );
      process.exitCode = 2;
      return;
    }
    if (cfg.provider !== "openrouter") {
      console.error(`Refusing non-openrouter provider: ${cfg.provider}`);
      process.exitCode = 2;
      return;
    }

    resetSpendState();
    const mandate = baseMandate({ per_trade_limit_usd: 20 });
    // Live market (CoinGecko) → Researcher → Strategist → Fitter → Critic. No fixtures.
    const live = await runGateJPipeline({
      mandate,
      balances: { usdc: "50" },
      marketFixture: null,
      useLlm: true,
      useResearcher: true,
      criticFixture: null,
      dryRun: true,
      allowExecute: false,
      forecast: {
        note: "testnet dry-run; prefer small USDC->wNEAR only if edge covers costs",
        suggested_pair: "USDC/wNEAR",
        engine: "deterministic_statistical_placeholder",
      },
    });

    const modelsOk =
      live.researcher?.ok &&
      live.strategist?.ok &&
      live.critic?.ok &&
      live.researcher?.llm?.provider === "openrouter" &&
      live.strategist?.llm?.provider === "openrouter" &&
      live.critic?.llm?.provider === "openrouter";

    const liveOut = sanitizeTrace({
      gate: "J-live-llm",
      provider: "openrouter",
      dry_run: true,
      DRY_RUN: true,
      no_signing: true,
      funded_execution: false,
      created_at: new Date().toISOString(),
      llm_config: cfg,
      models_requested: cfg.models,
      models_returned: {
        researcher: live.researcher?.llm?.model || null,
        strategist: live.strategist?.llm?.model || null,
        critic: live.critic?.llm?.model || live.critic?.review?.model || null,
      },
      request_ids: {
        researcher: live.researcher?.llm?.request_id || null,
        strategist: live.strategist?.llm?.request_id || null,
        critic: live.critic?.llm?.request_id || null,
      },
      market_input: live.market,
      researcher: live.researcher,
      strategist: live.strategist,
      fitter: live.fitter,
      fitter_after_critic: live.fitter_after_critic,
      critic: live.critic,
      enforcement: live.enforcement,
      summary: live.summary,
      spend: live.spend,
      latency: {
        researcher_ms: live.researcher?.llm?.latency_ms ?? null,
        strategist_ms: live.strategist?.llm?.latency_ms ?? null,
        critic_ms: live.critic?.llm?.latency_ms ?? null,
      },
      verified_real_ai: modelsOk,
      disclaimer:
        "Genuine OpenRouter-backed decision trace in dry-run. Not a Gate I Sepolia fill. Fixture fallbacks are never labeled as real AI.",
      primary_trace: live,
    });

    writeFileSync(
      join(EVIDENCE, "gate-j-live-llm.json"),
      JSON.stringify(liveOut, null, 2)
    );
    console.log(
      "LIVE_LLM",
      modelsOk ? "VERIFIED" : "FAIL_CLOSED",
      live.summary || live.enforcement
    );
    if (!modelsOk) process.exitCode = 3;
  }

  console.log("wrote evidence/live/gate-j-*.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
