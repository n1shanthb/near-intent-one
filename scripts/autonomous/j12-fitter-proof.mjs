#!/usr/bin/env node
/**
 * Deterministic fitter negotiation proof (resize / reject) — no LLM required.
 */
import { writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fitMandate } from "../../packages/gate-j/fitter.mjs";
import {
  scenarioAdapted,
  scenarioRejected,
  scenarioCriticVeto,
  baseStrategistProposal,
  baseMandate,
  freshMarket,
} from "../../packages/gate-j/fixtures.mjs";
import { runStrategistFixture } from "../../packages/gate-j/strategist.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function run(scenario) {
  const strat = runStrategistFixture(scenario.proposal);
  return fitMandate({
    proposal: strat.proposal,
    mandate: scenario.mandate,
    market: scenario.market,
    critic:
      scenario.critic === "REJECT"
        ? { verdict: "REJECT", reasons: ["risk"] }
        : scenario.critic === "APPROVE"
          ? { verdict: "APPROVE", reasons: [] }
          : null,
  });
}

const adapted = run(scenarioAdapted());
const rejected = run(scenarioRejected());
const critic = run(scenarioCriticVeto());
const noTrade = fitMandate({
  proposal: runStrategistFixture(
    baseStrategistProposal({
      choice: "NO_TRADE",
      proposed_size_usd: 0,
      min_viable_size_usd: 0,
    })
  ).proposal,
  mandate: baseMandate(),
  market: freshMarket(),
  critic: null,
});

const report = {
  kind: "J12_FITTER_NEGOTIATION",
  cases: [
    {
      name: "adapt_oversized_to_mandate",
      outcome: adapted.outcome,
      reason_codes: adapted.reason_codes,
      parameters_changed: adapted.parameters_changed,
      fitted_size: adapted.fitted_proposal?.proposed_size_usdc_raw || null,
    },
    {
      name: "reject_below_min_viable_after_fit",
      outcome: rejected.outcome,
      reason_codes: rejected.reason_codes,
    },
    {
      name: "critic_veto",
      outcome: critic.outcome,
      reason_codes: critic.reason_codes,
    },
    {
      name: "strategist_no_trade",
      outcome: noTrade.outcome,
      reason_codes: noTrade.reason_codes,
    },
  ],
};

const adaptOk = adapted.outcome === "ADAPTED";
const rejectOk = rejected.outcome === "REJECTED";
const criticOk = critic.outcome === "REJECTED";
const noTradeOk = noTrade.outcome === "REJECTED";
report.pass = Boolean(adaptOk && rejectOk && criticOk && noTradeOk);
report.verdict = report.pass ? "PASS" : "FAIL";

const out = join(ROOT, "docs", "evidence", "J12_FITTER_NEGOTIATION.json");
await writeFile(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.pass ? 0 : 1);
