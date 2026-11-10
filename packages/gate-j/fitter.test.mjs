/**
 * Gate J — deterministic fitter + scenario tests (no LLM required).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fitMandate } from "./fitter.mjs";
import { finalEnforce } from "./enforce.mjs";
import { runStrategistFixture } from "./strategist.mjs";
import { runGateJPipeline } from "./pipeline.mjs";
import {
  scenarioAllowed,
  scenarioAdapted,
  scenarioRejected,
  scenarioUnauthorizedToken,
  scenarioUnsupportedChain,
  scenarioExpiredQuote,
  scenarioInsufficientBalance,
  scenarioDailyLimit,
  scenarioLimitEvasion,
  scenarioStaleMarket,
  scenarioCriticVeto,
  scenarioRevoked,
} from "./fixtures.mjs";
import { usdcRawFromUsd } from "./types.mjs";

function runFit(scenarioFn) {
  const s = scenarioFn();
  const strat = runStrategistFixture(s.proposal);
  assert.equal(strat.ok, true);
  return fitMandate({
    proposal: strat.proposal,
    mandate: s.mandate,
    market: s.market,
    critic: s.critic ? { verdict: s.critic } : null,
  });
}

describe("Gate J Mandate Fitter — core scenarios", () => {
  it("A ALLOWED: $10 propose / $20 permit", () => {
    const r = runFit(scenarioAllowed);
    assert.equal(r.outcome, "ALLOWED");
    assert.equal(r.fitted_proposal.proposed_size_usdc_raw, usdcRawFromUsd(10));
    assert.ok(r.economic_viability.ok);
  });

  it("B ADAPTED: $100 propose / $20 permit / min $10 → $20", () => {
    const r = runFit(scenarioAdapted);
    assert.equal(r.outcome, "ADAPTED");
    assert.equal(r.fitted_proposal.proposed_size_usdc_raw, usdcRawFromUsd(20));
    assert.ok(r.parameters_changed.some((c) => c.parameter === "proposed_size_usdc_raw"));
    assert.ok(r.economic_viability.ok);
  });

  it("C REJECTED: $100 propose / $20 permit / min $50", () => {
    const r = runFit(scenarioRejected);
    assert.equal(r.outcome, "REJECTED");
    assert.equal(r.fitted_proposal, null);
    assert.ok(r.reason_codes.includes("MIN_VIABLE_NOT_MET"));
  });
});

describe("Gate J Mandate Fitter — edge cases", () => {
  it("rejects unauthorized token", () => {
    const r = runFit(scenarioUnauthorizedToken);
    assert.equal(r.outcome, "REJECTED");
    assert.ok(r.reason_codes.includes("UNAUTHORIZED_ASSET"));
  });

  it("rejects unsupported chain", () => {
    const r = runFit(scenarioUnsupportedChain);
    assert.equal(r.outcome, "REJECTED");
    assert.ok(r.reason_codes.includes("UNSUPPORTED_NETWORK"));
  });

  it("rejects expired quote", () => {
    const r = runFit(scenarioExpiredQuote);
    assert.equal(r.outcome, "REJECTED");
    assert.ok(r.reason_codes.includes("EXPIRED_QUOTE"));
  });

  it("rejects insufficient balance", () => {
    const r = runFit(scenarioInsufficientBalance);
    assert.equal(r.outcome, "REJECTED");
    assert.ok(r.reason_codes.includes("INSUFFICIENT_BALANCE"));
  });

  it("rejects daily limit exhaustion", () => {
    const r = runFit(scenarioDailyLimit);
    assert.equal(r.outcome, "REJECTED");
    assert.ok(r.reason_codes.includes("DAILY_LIMIT_EXHAUSTED"));
  });

  it("rejects limit evasion via chunked ops", () => {
    const r = runFit(scenarioLimitEvasion);
    assert.equal(r.outcome, "REJECTED");
    assert.ok(r.reason_codes.includes("LIMIT_EVASION_ATTEMPT"));
  });

  it("rejects stale market", () => {
    const r = runFit(scenarioStaleMarket);
    assert.equal(r.outcome, "REJECTED");
    assert.ok(r.reason_codes.includes("STALE_MARKET_DATA"));
  });

  it("rejects critic veto", () => {
    const r = runFit(scenarioCriticVeto);
    assert.equal(r.outcome, "REJECTED");
    assert.ok(r.reason_codes.includes("CRITIC_VETO"));
  });

  it("rejects revoked policy", () => {
    const r = runFit(scenarioRevoked);
    assert.equal(r.outcome, "REJECTED");
    assert.ok(r.reason_codes.includes("MANDATE_REVOKED"));
  });

  it("never increases size above proposal", () => {
    const s = scenarioAllowed();
    s.mandate.per_trade_limit_usdc_raw = usdcRawFromUsd(1000);
    const strat = runStrategistFixture(s.proposal);
    const r = fitMandate({
      proposal: strat.proposal,
      mandate: s.mandate,
      market: s.market,
    });
    assert.equal(r.outcome, "ALLOWED");
    assert.ok(r.fitted_proposal);
    assert.ok(
      BigInt(r.fitted_proposal.proposed_size_usdc_raw) <=
        BigInt(strat.proposal.proposed_size_usdc_raw)
    );
  });
});

describe("Gate J enforcement dry-run", () => {
  it("ALLOWED path is dry-run EXECUTE_DRY_RUN and may_sign false", async () => {
    const s = scenarioAllowed();
    const trace = await runGateJPipeline({
      mandate: s.mandate,
      fixtureProposal: s.proposal,
      marketFixture: s.market,
      criticFixture: "APPROVE",
      dryRun: true,
      allowExecute: false,
    });
    assert.equal(trace.fitter_after_critic.outcome, "ALLOWED");
    assert.equal(trace.enforcement.decision, "EXECUTE_DRY_RUN");
    assert.equal(trace.enforcement.may_sign, false);
  });

  it("REJECTED path never signs", async () => {
    const s = scenarioRejected();
    const trace = await runGateJPipeline({
      mandate: s.mandate,
      fixtureProposal: s.proposal,
      marketFixture: s.market,
      criticFixture: "APPROVE",
      dryRun: true,
      allowExecute: true,
    });
    assert.equal(trace.fitter_after_critic.outcome, "REJECTED");
    assert.equal(trace.enforcement.may_sign, false);
    assert.ok(["NO_TRADE", "BLOCKED"].includes(trace.enforcement.decision));
  });

  it("critic ABSTAIN fails closed", () => {
    const s = scenarioAllowed();
    const strat = runStrategistFixture(s.proposal);
    const enf = finalEnforce({
      proposal: strat.proposal,
      mandate: s.mandate,
      market: s.market,
      fitResult: { outcome: "ALLOWED" },
      criticReview: { verdict: "ABSTAIN", reasons: ["uncertain"] },
      dryRun: true,
      allowExecute: false,
    });
    assert.equal(enf.decision, "BLOCKED");
    assert.equal(enf.may_sign, false);
    assert.ok(enf.reason_codes.includes("CRITIC_ABSTAIN"));
  });

  it("fitter REJECTED blocks even if critic APPROVE", () => {
    const s = scenarioRejected();
    const strat = runStrategistFixture(s.proposal);
    const enf = finalEnforce({
      proposal: strat.proposal,
      mandate: s.mandate,
      market: s.market,
      fitResult: { outcome: "REJECTED", reason_codes: ["MIN_VIABLE_NOT_MET"] },
      criticReview: { verdict: "APPROVE", reasons: ["looks fine"] },
      dryRun: true,
      allowExecute: false,
    });
    assert.equal(enf.decision, "BLOCKED");
    assert.equal(enf.may_sign, false);
    assert.ok(enf.reason_codes.includes("FITTER_REJECTED"));
    assert.ok(
      enf.checks.some(
        (c) => c.name === "critic" && c.note === "APPROVE_ignored_fitter_already_rejected"
      )
    );
  });

  it("strategist NO_TRADE reports STRATEGIST_NO_TRADE + FITTER_REJECTED", () => {
    const s = scenarioAllowed();
    const enf = finalEnforce({
      proposal: {
        ...s.proposal,
        choice: "NO_TRADE",
        proposed_size_usdc_raw: "0",
        min_viable_size_usdc_raw: "0",
      },
      mandate: s.mandate,
      market: s.market,
      fitResult: { outcome: "REJECTED" },
      criticReview: { verdict: "ABSTAIN", reasons: ["nothing to review"] },
      dryRun: true,
      allowExecute: false,
    });
    assert.equal(enf.decision, "NO_TRADE");
    assert.equal(enf.may_sign, false);
    assert.ok(enf.reason_codes.includes("STRATEGIST_NO_TRADE"));
    assert.ok(enf.reason_codes.includes("FITTER_REJECTED"));
    assert.ok(enf.reason_codes.includes("CRITIC_ABSTAIN"));
  });
});
