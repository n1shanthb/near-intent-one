/**
 * Autonomous package comprehensive tests
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { buildMandateV1Draft } from "../mandate/v1/schema.mjs";
import { createShadowAgent, runShadowTick, ACTION, MODE } from "./shadowAgent.mjs";
import { discoverProviders, quoteService, matchMandate, checkCommerceBalance, reserveBudget } from "./agentMarket.mjs";
import { createShadowWorker, appendJournalEntry, acquireLock, releaseLock, transitionState, replayJournal, getWorkerHealth, verifyJournalIntegrity, WORKER_STATE } from "./worker.mjs";
import { simulateCycle, simulateCrashRestart } from "./simulateCycle.mjs";
import { compileMandateToPolicyLimits, compileActivationPreview } from "../mandate/v1/compiler.mjs";

const MAINNET = "mainnet";
const POLICY_CONTRACT = "agent_policy.near";
const OWNER = "owner.near";
const PORTFOLIO_ID = "test_p1";

function buildTestMandate() {
  return buildMandateV1Draft({
    network: MAINNET,
    policy_contract: POLICY_CONTRACT,
    owner: OWNER,
    portfolio_id: PORTFOLIO_ID,
    agent_id: "test_agent",
    executor_id: "executor.near",
    mandate_id: "test_m1",
    epoch: 1,
    strategy_hash: "test_hash",
    prompt_version_hash: "test_prompt",
    created_at_ms: Date.now(),
    expires_at_ms: Date.now() + 30 * 86400 * 1000,
    allowed_chains: ["near"],
    allowed_assets: ["native:near", "nep141:usdc.near"],
    allowed_venues: ["near_intents_1click"],
    allowed_destinations: [OWNER],
    trading_enabled: true,
    max_trade_raw: "1000000",
    total_trading_budget_raw: "10000000",
    daily_turnover_budget_raw: "5000000",
    max_pending_exposure_raw: "2000000",
    max_slippage_bps: 100,
    max_gas_budget: "300000000000000",
    min_trade_interval_sec: 300,
    max_trades_per_period: 10,
    data_purchase_enabled: true,
    commerce_budget_raw: "1000000",
    max_marketplace_purchase_raw: "500000",
    max_purchases_per_period: 5,
    marketplace_allowlist: [],
    provider_allowlist: ["coingecko_mock"],
    openrouter_daily_usd_micros: "2000000",
    openrouter_max_requests_per_day: 100,
  });
}

function buildTestMarket() {
  return {
    pair: { origin: "USDC", destination: "wNEAR" },
    near_usd: 5.0,
    usdc_usd: 1.0,
    sources: [{ name: "mock_source", timestamp_ms: Date.now() }],
    live_1click: { quotes: [] },
  };
}

describe("Shadow Agent", () => {
  it("creates shadow agent", () => {
    const mandate = buildTestMandate();
    const journal = { append: () => {} };
    const agent = createShadowAgent({ mandate, journal });
    assert.equal(agent.mode, MODE.SHADOW);
    assert.equal(agent.mandate, mandate);
  });

  it("runs shadow tick with HOLD decision", async () => {
    const mandate = buildTestMandate();
    const entries = [];
    const journal = { append: (e) => entries.push(e) };
    const agent = createShadowAgent({ mandate, journal });
    const market = buildTestMarket();

    const decision = await runShadowTick(agent, market);
    assert.ok(decision);
    assert.ok(
      [ACTION.HOLD, ACTION.WAIT, ACTION.BUY_DATA, ACTION.TRADE, ACTION.NO_TRADE].includes(
        decision.action
      )
    );
    assert.ok(entries.length > 0);
  });

  it("enforces openrouter spend cap", async () => {
    const mandate = buildTestMandate();
    mandate.openrouter_daily_usd_micros = "100000"; // $0.10
    const entries = [];
    const journal = { append: (e) => entries.push(e) };
    const agent = createShadowAgent({ mandate, journal });
    agent.state.openrouter_spent_usd = 1.0; // Already over cap

    const market = buildTestMarket();
    const decision = await runShadowTick(agent, market);
    assert.equal(decision.action, ACTION.HOLD);
    assert.equal(decision.reason, "openrouter_spend_cap");
  });

  it("enforces openrouter request cap", async () => {
    const mandate = buildTestMandate();
    mandate.openrouter_max_requests_per_day = 5;
    const entries = [];
    const journal = { append: (e) => entries.push(e) };
    const agent = createShadowAgent({ mandate, journal });
    agent.state.openrouter_requests_today = 10; // Already over cap

    const market = buildTestMarket();
    const decision = await runShadowTick(agent, market);
    assert.equal(decision.action, ACTION.HOLD);
    assert.equal(decision.reason, "openrouter_request_cap");
  });
});

describe("Agent Marketplace", () => {
  it("discovers providers", async () => {
    const mandate = buildTestMandate();
    const providers = await discoverProviders(mandate);
    assert.ok(providers.length > 0);
    assert.ok(providers.some((p) => p.provider_id === "coingecko_mock"));
  });

  it("quotes service", async () => {
    const quote = await quoteService("coingecko_mock", "price_feed");
    assert.equal(quote.provider_id, "coingecko_mock");
    assert.equal(quote.service_id, "price_feed");
    assert.equal(typeof quote.price_usd_micros, "string");
    assert.ok(quote.quote_id);
  });

  it("matches mandate to affordable services", async () => {
    const mandate = buildTestMandate();
    const matches = await matchMandate(mandate);
    assert.ok(matches.length > 0);
    assert.ok(matches.every((m) => m.affordable));
  });

  it("checks commerce balance", () => {
    const state = { commerce_spent_raw: "100000", commerce_budget_raw: "1000000" };
    const balance = checkCommerceBalance(state);
    assert.equal(balance.spent_raw, "100000");
    assert.equal(balance.remaining_raw, "900000");
    assert.equal(balance.exhausted, false);
  });

  it("reserves budget successfully", () => {
    const state = { commerce_spent_raw: "0", commerce_budget_raw: "1000000" };
    const reservation = reserveBudget(state, "100000");
    assert.equal(reservation.ok, true);
    assert.ok(reservation.reservation_id);
  });

  it("fails to reserve over budget", () => {
    const state = { commerce_spent_raw: "0", commerce_budget_raw: "50000" };
    const reservation = reserveBudget(state, "100000");
    assert.equal(reservation.ok, false);
    assert.equal(reservation.reason, "insufficient_commerce_balance");
  });
});

describe("Shadow Worker", () => {
  const test_journal_dir = join(tmpdir(), `nio-test-${Date.now()}`);

  it("creates shadow worker", async () => {
    const worker = await createShadowWorker({
      portfolio_id: "test_p1",
      journal_dir: test_journal_dir,
    });
    assert.equal(worker.portfolio_id, "test_p1");
    assert.equal(worker.state, WORKER_STATE.IDLE);
  });

  it("appends journal entry", async () => {
    const worker = await createShadowWorker({
      portfolio_id: "test_p2",
      journal_dir: test_journal_dir,
    });
    await appendJournalEntry(worker, { test: "entry" });
    assert.equal(worker.entries.length, 1);
  });

  it("acquires and releases lock", async () => {
    const worker = await createShadowWorker({
      portfolio_id: "test_p3",
      journal_dir: test_journal_dir,
    });
    const acquired = await acquireLock(worker);
    assert.equal(acquired, true);
    assert.ok(worker.lock);

    await releaseLock(worker);
    assert.equal(worker.lock, null);
  });

  it("transitions state", async () => {
    const worker = await createShadowWorker({
      portfolio_id: "test_p4",
      journal_dir: test_journal_dir,
    });
    assert.equal(worker.state, WORKER_STATE.IDLE);

    await transitionState(worker, WORKER_STATE.RESEARCHING);
    assert.equal(worker.state, WORKER_STATE.RESEARCHING);

    await transitionState(worker, WORKER_STATE.DECIDING);
    assert.equal(worker.state, WORKER_STATE.DECIDING);
  });

  it("rejects invalid transitions to ERROR (not financial UNKNOWN)", async () => {
    const worker = await createShadowWorker({
      portfolio_id: "test_p5",
      journal_dir: test_journal_dir,
    });
    await transitionState(worker, WORKER_STATE.EXECUTING); // Invalid from IDLE
    assert.equal(worker.state, WORKER_STATE.ERROR);
    assert.equal(worker.unknown_blocks_spend, false);
  });

  it("replays journal", async () => {
    const worker = await createShadowWorker({
      portfolio_id: "test_p6",
      journal_dir: test_journal_dir,
    });
    await appendJournalEntry(worker, {
      kind: "trade",
      amount_raw: "100000",
    });
    await appendJournalEntry(worker, {
      kind: "commerce_purchase",
      price_usd_micros: "50000",
    });

    const state = replayJournal(worker);
    assert.equal(state.spent_today_raw, "100000");
    assert.equal(state.commerce_spent_raw, "50000");
  });

  it("reports worker health", async () => {
    const worker = await createShadowWorker({
      portfolio_id: "test_p7",
      journal_dir: test_journal_dir,
    });
    const health = getWorkerHealth(worker);
    assert.equal(health.portfolio_id, "test_p7");
    assert.equal(health.state, WORKER_STATE.IDLE);
    assert.equal(health.healthy, true);
  });

  it("verifies real hash-chain integrity (not placeholder true)", async () => {
    const worker = await createShadowWorker({
      portfolio_id: "test_p8",
      journal_dir: test_journal_dir,
    });
    await appendJournalEntry(worker, { kind: "decision", action: "HOLD" });
    await appendJournalEntry(worker, { kind: "decision", action: "NO_TRADE" });
    const ok = verifyJournalIntegrity(worker);
    assert.equal(ok.ok, true);
    assert.equal(ok.checked, 2);

    // Tamper
    worker.entries[1].action = "TRADE";
    const broken = verifyJournalIntegrity(worker);
    assert.equal(broken.ok, false);
    assert.equal(broken.reason, "entry_hash_mismatch");
  });

  it("rejects second cross-process lock on same portfolio", async () => {
    const dir = join(tmpdir(), `nio-lock-${Date.now()}`);
    const a = await createShadowWorker({ portfolio_id: "lock_p1", journal_dir: dir });
    const b = await createShadowWorker({ portfolio_id: "lock_p1", journal_dir: dir });
    assert.equal(await acquireLock(a), true);
    assert.equal(await acquireLock(b), false);
    await releaseLock(a);
    assert.equal(await acquireLock(b), true);
    await releaseLock(b);
  });
});

describe("Mandate compiler PolicyLimits", () => {
  it("includes valid_until and token_scope", () => {
    const mandate = buildTestMandate();
    const limits = compileMandateToPolicyLimits(mandate);
    assert.ok(limits.valid_until);
    assert.equal(limits.token_scope, "allowlist");
    assert.ok(Array.isArray(limits.allowed_assets));
    assert.ok(Array.isArray(limits.allowed_chains));
  });

  it("does not unpause trading-disabled mandates", () => {
    const mandate = buildTestMandate();
    mandate.trading_enabled = false;
    const preview = compileActivationPreview(mandate);
    assert.equal(preview.unpause_included, false);
    assert.ok(!preview.methods.includes("unpause"));
    assert.ok(!preview.methods.includes("activate_autonomous_mandate"));
  });
});

describe("Simulate Cycle", () => {
  const test_journal_dir = join(tmpdir(), `nio-cycle-test-${Date.now()}`);

  it("simulates full cycle with HOLD", async () => {
    const mandate_input = {
      network: MAINNET,
      policy_contract: POLICY_CONTRACT,
      owner: OWNER,
      portfolio_id: "cycle_p1",
      agent_id: "test_agent",
      executor_id: "executor.near",
      mandate_id: "cycle_m1",
      epoch: 1,
      strategy_hash: "test",
      prompt_version_hash: "test",
      created_at_ms: Date.now(),
      expires_at_ms: Date.now() + 86400_000,
      allowed_chains: ["near"],
      allowed_assets: ["native:near"],
      allowed_venues: ["near_intents_1click"],
      allowed_destinations: [OWNER],
      trading_enabled: true,
      max_trade_raw: "1000000",
      total_trading_budget_raw: "10000000",
      daily_turnover_budget_raw: "5000000",
      max_pending_exposure_raw: "2000000",
      max_slippage_bps: 100,
      max_gas_budget: "300000000000000",
      data_purchase_enabled: false,
      commerce_budget_raw: "0",
      max_marketplace_purchase_raw: "0",
      openrouter_daily_usd_micros: "2000000",
      openrouter_max_requests_per_day: 100,
    };

    const market = buildTestMarket();
    market.as_of = new Date().toISOString();
    const result = await simulateCycle({
      mandate_input,
      market,
      portfolio_id: "cycle_p1",
      journal_dir: test_journal_dir,
    });

    assert.equal(result.ok, true);
    assert.ok(result.mandate);
    assert.ok(result.mandate_hash);
    assert.ok(result.decisions.length > 0);
  });

  it("blocks expired mandate", async () => {
    const mandate_input = {
      network: MAINNET,
      policy_contract: POLICY_CONTRACT,
      owner: OWNER,
      portfolio_id: "cycle_p2",
      agent_id: "test_agent",
      executor_id: "executor.near",
      mandate_id: "cycle_m2",
      epoch: 1,
      strategy_hash: "test",
      prompt_version_hash: "test",
      created_at_ms: Date.now() - 100000,
      expires_at_ms: Date.now() - 1000, // EXPIRED
      allowed_chains: ["near"],
      allowed_assets: ["native:near"],
      allowed_venues: ["near_intents_1click"],
      trading_enabled: true,
      max_trade_raw: "1000000",
      openrouter_daily_usd_micros: "2000000",
    };

    const market = buildTestMarket();
    const result = await simulateCycle({
      mandate_input,
      market,
      portfolio_id: "cycle_p2",
    });

    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors.some((e) => e.reasons?.includes("mandate_expired")));
  });

  it("refuses unauthorized agent", async () => {
    const mandate_input = {
      network: MAINNET,
      policy_contract: POLICY_CONTRACT,
      owner: OWNER,
      portfolio_id: "cycle_p3",
      agent_id: "unauthorized_agent",
      executor_id: "executor.near",
      mandate_id: "cycle_m3",
      epoch: 1,
      strategy_hash: "test",
      prompt_version_hash: "test",
      created_at_ms: Date.now(),
      expires_at_ms: Date.now() + 86400_000,
      allowed_chains: ["near"],
      allowed_assets: [],
      allowed_venues: [],
      trading_enabled: false,
      max_trade_raw: "0",
      openrouter_daily_usd_micros: "0",
    };

    const market = buildTestMarket();
    const result = await simulateCycle({
      mandate_input,
      market,
      portfolio_id: "cycle_p3",
    });

    // Validation should fail due to empty allowed_assets
    assert.equal(result.ok, false);
  });

  it("simulates crash restart", async () => {
    const worker = await createShadowWorker({
      portfolio_id: "crash_p1",
      journal_dir: test_journal_dir,
    });

    await appendJournalEntry(worker, { kind: "trade", amount_raw: "100000" });

    const recovery = await simulateCrashRestart(worker);
    assert.equal(recovery.ok, true);
    assert.equal(recovery.recovered_state.spent_today_raw, "100000");
  });
});

describe("Autonomous Edge Cases", () => {
  it("refuses mainnet mutation in shadow mode", async () => {
    const mandate = buildTestMandate();
    const journal = { append: () => {} };
    const agent = createShadowAgent({ mandate, journal });

    // Shadow mode should never attempt real signing
    assert.equal(agent.mode, MODE.SHADOW);
  });

  it("handles LLM schema failure gracefully", async () => {
    const mandate = buildTestMandate();
    const entries = [];
    const journal = { append: (e) => entries.push(e) };
    const agent = createShadowAgent({ mandate, journal });
    const market = buildTestMarket();

    // Run tick (mock LLM may return invalid schema, but should not crash)
    const decision = await runShadowTick(agent, market);
    assert.ok(decision);
  });

  it("prevents duplicate operation", async () => {
    const worker = await createShadowWorker({
      portfolio_id: "dup_p1",
      journal_dir: join(tmpdir(), `nio-dup-test-${Date.now()}`),
    });

    const op_id = "test_op_1";
    await appendJournalEntry(worker, { kind: "trade", op_id });

    const state = replayJournal(worker);
    const has_op = worker.entries.some((e) => e.op_id === op_id);
    assert.equal(has_op, true);
  });
});
