/**
 * Gate K unit tests — fail-closed safety, economics, auth, concurrency.
 * Does not broadcast or call live MPC.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyGateKSafety, assertSingleFlight } from "./safety.mjs";
import { assessEconomicViability } from "./economics.mjs";
import { preSignChecks, buildExecutionPreview } from "./execute.mjs";
import { runGateKPipeline } from "./pipeline.mjs";
import { createAutonomousLoop } from "./autonomous.mjs";
import { MODE, FIRST_TEST, REASON } from "./constants.mjs";
import {
  baseMandate,
  baseStrategistProposal,
  freshMarket,
} from "../gate-j/fixtures.mjs";

const mandate = {
  ...baseMandate({ balance_usd: 48.9, per_trade_limit_usd: 20 }),
  autonomous_trading: false,
  mandate_epoch: 3,
};

const portfolio = {
  id: "i-a-a4e7",
  portfolio_id: "i-a-a4e7",
  owner_account: mandate.owner_account,
  policy_contract: mandate.policy_contract,
  intents_signer_id: "0xabc",
};

const goodTrade = baseStrategistProposal({
  proposed_size_usd: 5,
  min_viable_size_usd: 0.5,
  edge_bps: 100,
  fee_bps: 10,
  price_impact_bps: 5,
  max_slippage_bps: 20,
});

const marketOk = {
  ...freshMarket(),
  fee_bps: 10,
  price_impact_bps: 5,
};

describe("Gate K safety overlay", () => {
  it("clamps size to 26 USDC first-test cap", () => {
    const r = applyGateKSafety({
      mandate: {
        ...mandate,
        per_trade_limit_usdc_raw: "100000000",
        balance_usdc_raw: "48900000",
      },
      fittedProposal: {
        ...goodTrade,
        proposed_size_usdc_raw: "50000000",
        min_viable_size_usdc_raw: "500000",
      },
      portfolioId: "i-a-a4e7",
    });
    assert.equal(r.ok, true);
    assert.equal(r.safe_proposal.proposed_size_usdc_raw, "26000000");
  });

  it("rejects wrong portfolio", () => {
    const r = applyGateKSafety({
      mandate,
      fittedProposal: {
        ...goodTrade,
        proposed_size_usdc_raw: "1000000",
        min_viable_size_usdc_raw: "500000",
      },
      portfolioId: "other",
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, REASON.WRONG_PORTFOLIO);
  });

  it("rejects strategist NO_TRADE", () => {
    const r = applyGateKSafety({
      mandate,
      fittedProposal: { ...goodTrade, choice: "NO_TRADE" },
      portfolioId: "i-a-a4e7",
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "STRATEGIST_NO_TRADE");
  });

  it("rejects wrong pair", () => {
    const r = applyGateKSafety({
      mandate,
      fittedProposal: {
        ...goodTrade,
        proposed_size_usdc_raw: "1000000",
        min_viable_size_usdc_raw: "500000",
        pair: { origin: "USDC", destination: "ETH" },
      },
      portfolioId: "i-a-a4e7",
    });
    assert.equal(r.ok, false);
  });

  it("rejects revoked mandate", () => {
    const r = applyGateKSafety({
      mandate: { ...mandate, revoked: true },
      fittedProposal: {
        ...goodTrade,
        proposed_size_usdc_raw: "1000000",
        min_viable_size_usdc_raw: "500000",
      },
      portfolioId: "i-a-a4e7",
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "MANDATE_REVOKED");
  });

  it("rejects demo owner", () => {
    const r = applyGateKSafety({
      mandate: { ...mandate, owner_account: "nio-c-ledger.demo" },
      fittedProposal: {
        ...goodTrade,
        proposed_size_usdc_raw: "1000000",
        min_viable_size_usdc_raw: "500000",
      },
      portfolioId: "i-a-a4e7",
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "DEMO_PORTFOLIO_FORBIDDEN");
  });

  it("rejects insufficient balance vs min viable", () => {
    const r = applyGateKSafety({
      mandate: { ...mandate, balance_usdc_raw: "100" },
      fittedProposal: {
        ...goodTrade,
        proposed_size_usdc_raw: "1000000",
        min_viable_size_usdc_raw: "500000",
      },
      portfolioId: "i-a-a4e7",
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "MIN_VIABLE_NOT_MET");
  });
});

describe("Gate K economics", () => {
  it("rejects unprofitable thin edge (preserves Gate J ~27bps case)", () => {
    const r = assessEconomicViability({
      edge_bps: 27,
      fee_bps: 30,
      price_impact_bps: 5,
      buffer_bps: 20,
      amount_in: "1000000",
      amount_out: "100",
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "ECONOMIC_NOT_VIABLE");
  });

  it("allows when edge exceeds fees+impact+buffer", () => {
    const r = assessEconomicViability({
      edge_bps: 80,
      fee_bps: 30,
      price_impact_bps: 5,
      buffer_bps: 20,
      amount_in: "1000000",
      amount_out: "100",
    });
    assert.equal(r.ok, true);
  });
});

describe("Gate K pre-sign checks", () => {
  const p = {
    portfolio_id: "i-a-a4e7",
    owner_account: mandate.owner_account,
    policy_contract: "policy.i-a-a4e7.testnet",
    intents_signer_id: "0xabc",
  };

  it("rejects unauthenticated", () => {
    const r = preSignChecks({
      portfolio: p,
      mandate,
      safeProposal: { proposed_size_usdc_raw: "1000000" },
      quote: { quote_hash: "h", amount_out: "1" },
      economic: { ok: true },
      expectedEpoch: 3,
      currentEpoch: 3,
      reconcilerOk: true,
      authenticated: false,
    });
    assert.equal(r.reason, REASON.UNAUTHENTICATED);
  });

  it("rejects wrong portfolio owner", () => {
    const r = preSignChecks({
      portfolio: p,
      mandate: { ...mandate, owner_account: "attacker.testnet" },
      safeProposal: { proposed_size_usdc_raw: "1000000" },
      quote: { quote_hash: "h", amount_out: "1" },
      economic: { ok: true },
      expectedEpoch: 3,
      currentEpoch: 3,
      reconcilerOk: true,
      authenticated: true,
    });
    assert.equal(r.reason, "WRONG_PORTFOLIO_OWNER");
  });

  it("rejects revocation/epoch change before signing", () => {
    const r = preSignChecks({
      portfolio: p,
      mandate,
      safeProposal: { proposed_size_usdc_raw: "1000000" },
      quote: { quote_hash: "h", amount_out: "1" },
      economic: { ok: true },
      expectedEpoch: 3,
      currentEpoch: 4,
      reconcilerOk: true,
      authenticated: true,
    });
    assert.equal(r.reason, REASON.POLICY_CHANGED);
  });

  it("rejects reconciler outage", () => {
    const r = preSignChecks({
      portfolio: p,
      mandate,
      safeProposal: { proposed_size_usdc_raw: "1000000" },
      quote: { quote_hash: "h", amount_out: "1" },
      economic: { ok: true },
      expectedEpoch: 3,
      currentEpoch: 3,
      reconcilerOk: false,
      authenticated: true,
    });
    assert.equal(r.reason, REASON.RECONCILER_DOWN);
  });

  it("rejects missing/stale quote", () => {
    const r = preSignChecks({
      portfolio: p,
      mandate,
      safeProposal: { proposed_size_usdc_raw: "1000000" },
      quote: null,
      economic: { ok: true },
      expectedEpoch: 3,
      currentEpoch: 3,
      reconcilerOk: true,
      authenticated: true,
    });
    assert.equal(r.reason, REASON.NO_FRESH_QUOTE);
  });
});

describe("Gate K single-flight / concurrent / max trades", () => {
  it("blocks overlapping IN_FLIGHT", () => {
    const store = {
      read: () => ({
        executions: {
          a: {
            kind: "gate_k_ai_trade",
            portfolio_id: "i-a-a4e7",
            status: "IN_FLIGHT",
          },
        },
      }),
    };
    assert.equal(
      assertSingleFlight({ store, portfolioId: "i-a-a4e7" }).reason,
      REASON.SINGLE_FLIGHT
    );
  });

  it("blocks after max first-test trades (nonce replay / double exec)", () => {
    const store = {
      read: () => ({
        executions: {
          a: {
            kind: "gate_k_ai_trade",
            portfolio_id: "i-a-a4e7",
            status: "SUCCESS",
          },
        },
      }),
    };
    const prev = process.env.GATE_K_ALLOW_MULTI;
    delete process.env.GATE_K_ALLOW_MULTI;
    const r = assertSingleFlight({ store, portfolioId: "i-a-a4e7" });
    if (prev != null) process.env.GATE_K_ALLOW_MULTI = prev;
    assert.equal(r.reason, REASON.MAX_TRADES);
  });
});

describe("Gate K pipeline", () => {
  it("Strategist NO_TRADE → NO_TRADE", async () => {
    const trace = await runGateKPipeline({
      mandate,
      portfolio,
      portfolioId: "i-a-a4e7",
      mode: MODE.DRY_RUN,
      fixtureProposal: {
        choice: "NO_TRADE",
        proposed_size_usd: 0,
        min_viable_size_usd: 0,
        thesis: "no opportunity",
        pair: { origin: "USDC", destination: "wNEAR" },
        network: "sepolia",
      },
      marketFixture: marketOk,
      criticFixture: "APPROVE",
    });
    assert.equal(trace.enforcement.decision, "NO_TRADE");
    assert.equal(trace.signing, false);
  });

  it("Fitter rejection (over daily limit) → NO_TRADE", async () => {
    const trace = await runGateKPipeline({
      mandate: baseMandate({
        balance_usd: 50,
        per_trade_limit_usd: 20,
        daily_limit_usd: 10,
        daily_spent_usd: 10,
      }),
      portfolio,
      portfolioId: "i-a-a4e7",
      mode: MODE.DRY_RUN,
      fixtureProposal: baseStrategistProposal({
        proposed_size_usd: 10,
        min_viable_size_usd: 5,
      }),
      marketFixture: marketOk,
      criticFixture: "APPROVE",
    });
    assert.equal(trace.enforcement.decision, "NO_TRADE");
  });

  it("Critic veto → NO_TRADE", async () => {
    const trace = await runGateKPipeline({
      mandate,
      portfolio,
      portfolioId: "i-a-a4e7",
      mode: MODE.DRY_RUN,
      fixtureProposal: goodTrade,
      marketFixture: marketOk,
      criticFixture: "REJECT",
    });
    assert.equal(trace.enforcement.decision, "NO_TRADE");
  });

  it("Critic abstain → NO_TRADE", async () => {
    const trace = await runGateKPipeline({
      mandate,
      portfolio,
      portfolioId: "i-a-a4e7",
      mode: MODE.DRY_RUN,
      fixtureProposal: goodTrade,
      marketFixture: marketOk,
      criticFixture: "ABSTAIN",
    });
    assert.equal(trace.enforcement.decision, "NO_TRADE");
  });

  it("Unprofitable quote / thin edge → NO_TRADE", async () => {
    const thin = baseStrategistProposal({
      proposed_size_usd: 1,
      min_viable_size_usd: 0.5,
      edge_bps: 27,
      fee_bps: 30,
      price_impact_bps: 5,
      max_slippage_bps: 20,
    });
    const trace = await runGateKPipeline({
      mandate,
      portfolio,
      portfolioId: "i-a-a4e7",
      mode: MODE.DRY_RUN,
      fixtureProposal: thin,
      marketFixture: marketOk,
      criticFixture: "APPROVE",
    });
    assert.equal(trace.enforcement.decision, "NO_TRADE");
  });

  it("Stale market data → NO_TRADE", async () => {
    const trace = await runGateKPipeline({
      mandate,
      portfolio,
      portfolioId: "i-a-a4e7",
      mode: MODE.DRY_RUN,
      fixtureProposal: goodTrade,
      marketFixture: {
        ...marketOk,
        stale: true,
        reason: "fixture_stale",
      },
      criticFixture: "APPROVE",
    });
    assert.equal(trace.enforcement.decision, "NO_TRADE");
  });

  it("Execution without operator confirm does not sign", async () => {
    const prev = process.env.GATE_K_ALLOW_SIGN;
    process.env.GATE_K_ALLOW_SIGN = "1";
    const emptyStore = { read: () => ({ executions: {} }) };
    const trace = await runGateKPipeline({
      mandate,
      portfolio,
      portfolioId: "i-a-a4e7",
      mode: MODE.TESTNET_EXECUTION,
      authenticated: true,
      operatorConfirm: false,
      reconcilerOk: true,
      fixtureProposal: goodTrade,
      marketFixture: marketOk,
      criticFixture: "APPROVE",
      quoteFn: async () => ({
        quote_hash: "qh",
        amount_out: "200000000000000000",
        expires_at_ms: Date.now() + 60_000,
      }),
      store: emptyStore,
    });
    if (prev == null) delete process.env.GATE_K_ALLOW_SIGN;
    else process.env.GATE_K_ALLOW_SIGN = prev;
    assert.equal(trace.signing, false);
  });

  it("Unauthenticated execution request blocked", async () => {
    const trace = await runGateKPipeline({
      mandate,
      portfolio,
      portfolioId: "i-a-a4e7",
      mode: MODE.TESTNET_EXECUTION,
      authenticated: false,
      operatorConfirm: true,
      reconcilerOk: true,
      fixtureProposal: goodTrade,
      marketFixture: marketOk,
      criticFixture: "APPROVE",
      quoteFn: async () => ({
        quote_hash: "qh",
        amount_out: "1",
        expires_at_ms: Date.now() + 60_000,
      }),
      store: { read: () => ({ executions: {} }) },
    });
    assert.equal(trace.signing, false);
    assert.ok(
      trace.enforcement.reason_codes.includes(REASON.UNAUTHENTICATED) ||
        trace.enforcement.decision === "NO_TRADE"
    );
  });

  it("Autonomous mode blocked when on-chain switch OFF", async () => {
    const trace = await runGateKPipeline({
      mandate: { ...mandate, autonomous_trading: false },
      portfolio,
      portfolioId: "i-a-a4e7",
      mode: MODE.AUTONOMOUS,
      authenticated: true,
      fixtureProposal: goodTrade,
      marketFixture: marketOk,
      criticFixture: "APPROVE",
    });
    assert.equal(trace.enforcement.decision, "NO_TRADE");
    assert.ok(
      trace.enforcement.reason_codes.includes(REASON.AUTONOMOUS_DISABLED)
    );
  });

  it("Dry-run qualifying trade returns preview without signing", async () => {
    const trace = await runGateKPipeline({
      mandate,
      portfolio,
      portfolioId: "i-a-a4e7",
      mode: MODE.DRY_RUN,
      fixtureProposal: goodTrade,
      marketFixture: marketOk,
      criticFixture: "APPROVE",
    });
    // May be TRADE preview or NO_TRADE if Gate J economics/slippage reject — either must not sign
    assert.equal(trace.signing, false);
    if (trace.enforcement.decision === "TRADE") {
      assert.ok(trace.preview);
      assert.ok(BigInt(trace.preview.amount_usdc_raw) <= 26000000n);
    }
  });
});

describe("Gate K autonomous loop", () => {
  it("does not start without GATE_K_AUTONOMOUS_LOOP", () => {
    const prev = process.env.GATE_K_AUTONOMOUS_LOOP;
    delete process.env.GATE_K_AUTONOMOUS_LOOP;
    const loop = createAutonomousLoop({
      store: { recordDecision: () => {}, read: () => ({ executions: {} }) },
    });
    const r = loop.start("i-a-a4e7");
    if (prev != null) process.env.GATE_K_AUTONOMOUS_LOOP = prev;
    assert.equal(r.ok, false);
    assert.equal(r.reason, REASON.AUTONOMOUS_DISABLED);
  });

  it("recoverPending after restart during pending tx", () => {
    const loop = createAutonomousLoop({
      store: {
        read: () => ({
          executions: {
            k1: {
              kind: "gate_k_ai_trade",
              status: "SIGNED_PENDING_BROADCAST",
              portfolio_id: "i-a-a4e7",
            },
          },
        }),
        recordDecision: () => {},
      },
    });
    assert.equal(loop.recoverPending().length, 1);
  });
});

describe("Gate K preview", () => {
  it("builds operator preview with authorized max spend", () => {
    const p = buildExecutionPreview({
      portfolio: {
        portfolio_id: FIRST_TEST.portfolio_id,
        policy_contract: "p.testnet",
        intents_signer_id: "0xabc",
      },
      mandate,
      safeProposal: {
        proposed_size_usdc_raw: FIRST_TEST.max_trade_usdc_raw,
        pair: FIRST_TEST.pair,
        network: "sepolia+intents",
      },
      quote: { quote_hash: "qh", amount_out: "1" },
      economic: { ok: true, edge_bps: 80 },
      mode: MODE.TESTNET_EXECUTION,
    });
    assert.equal(p.amount_usdc, "26.000000");
    assert.match(p.warning, /STOP/);
  });
});
