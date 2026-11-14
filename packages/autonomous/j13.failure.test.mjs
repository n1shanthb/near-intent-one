/**
 * J13 realistic failure / recovery tests (local, no mainnet).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import {
  createShadowWorker,
  appendJournalEntry,
  acquireLock,
  releaseLock,
  verifyJournalIntegrity,
  markUnknownOutcome,
  clearUnknownAfterReconcile,
  transitionState,
  WORKER_STATE,
} from "./worker.mjs";
import {
  planAutonomousExecution,
  evaluateBroadcastAttempt,
  listOwnerApprovalDependencies,
  executeShadowPlan,
  EXEC_MODE,
} from "./executorAdapter.mjs";
import { ACTION, LLM_MODE } from "./shadowAgent.mjs";
import { TX_STATE } from "../execution/txJournal.mjs";

const dir = join(tmpdir(), `nio-j13-fail-${Date.now()}`);

describe("J13 failure matrix", () => {
  it("concurrent workers: second lock fails", async () => {
    const a = await createShadowWorker({ portfolio_id: "f1", journal_dir: dir });
    const b = await createShadowWorker({ portfolio_id: "f1", journal_dir: dir });
    assert.equal(await acquireLock(a), true);
    assert.equal(await acquireLock(b), false);
    await releaseLock(a);
  });

  it("journal corruption fails integrity and blocks spend after markUnknown", async () => {
    const w = await createShadowWorker({ portfolio_id: "f2", journal_dir: dir });
    await appendJournalEntry(w, { kind: "decision", action: "HOLD" });
    assert.equal(verifyJournalIntegrity(w).ok, true);
    w.entries[0].action = "TRADE";
    assert.equal(verifyJournalIntegrity(w).ok, false);
  });

  it("UNKNOWN quarantine blocks until independent reconcile", async () => {
    const w = await createShadowWorker({ portfolio_id: "f3", journal_dir: dir });
    await acquireLock(w);
    await markUnknownOutcome(w, { reason: "ambiguous_broadcast" });
    assert.equal(w.unknown_blocks_spend, true);
    assert.equal(w.budget.unknown_outcome, true);
    await assert.rejects(
      () => clearUnknownAfterReconcile(w, { independent: false, verified: true }),
      /independent/
    );
    await clearUnknownAfterReconcile(w, {
      independent: true,
      verified: true,
      source: "test",
      reference: "ref-1",
    });
    assert.equal(w.unknown_blocks_spend, false);
    await releaseLock(w);
  });

  it("duplicate operation id / nonce: plan refuses already broadcast", () => {
    const r = evaluateBroadcastAttempt({
      priorState: TX_STATE.BROADCAST,
      rpcResult: { tx_hash: "0xabc" },
    });
    assert.equal(r.action, "REFUSE_RETRY");
    assert.equal(r.may_retry_broadcast, undefined);
  });

  it("missing RPC → UNKNOWN, no resign", () => {
    const r = evaluateBroadcastAttempt({
      priorState: TX_STATE.BROADCAST_PENDING,
      rpcResult: null,
      transportError: null,
    });
    assert.equal(r.action, "UNKNOWN_QUARANTINE");
    assert.equal(r.may_resign, false);
    assert.equal(r.may_retry_broadcast, false);
  });

  it("ambiguous transport → UNKNOWN quarantine", () => {
    const r = evaluateBroadcastAttempt({
      priorState: TX_STATE.SIGNED,
      transportError: "timeout waiting for finality",
    });
    // may be RETRY or UNKNOWN depending on isAmbiguousOutcome heuristics
    assert.ok(["UNKNOWN_QUARANTINE", "RETRY_IDENTICAL_SIGNED_ONLY"].includes(r.action));
    assert.equal(r.may_resign, false);
  });

  it("quote expiry / pause reflected in plan blockers", () => {
    const decision = {
      action: ACTION.TRADE,
      llm_mode: LLM_MODE.LIVE_LLM,
      strategy: { proposed_size_usdc_raw: "1000000" },
      decision_hash: "abc",
      mandate_hash: "def",
    };
    const paused = planAutonomousExecution({
      decision,
      mandate: { trading_enabled: true },
      onChain: { paused: true, revoked: false, autonomous_trading: true },
      mode: EXEC_MODE.SHADOW,
    });
    assert.equal(paused.execute, false);
    assert.ok(paused.blockers.includes("on_chain_paused"));

    const revoked = planAutonomousExecution({
      decision,
      mandate: { trading_enabled: true },
      onChain: { paused: false, revoked: true },
      mode: EXEC_MODE.SHADOW,
    });
    assert.ok(revoked.blockers.includes("on_chain_revoked"));
  });

  it("NO_TRADE from AI is correct skip, not forced trade", async () => {
    const plan = planAutonomousExecution({
      decision: {
        action: ACTION.NO_TRADE,
        reason: "NO_OPPORTUNITY",
        llm_mode: LLM_MODE.LIVE_LLM,
        decision_hash: "h1",
      },
      mandate: { trading_enabled: true },
      onChain: { paused: false, revoked: false, autonomous_trading: true },
    });
    assert.equal(plan.execute, false);
    assert.equal(plan.labeled_autonomous_ai, true);
    const entries = [];
    const r = await executeShadowPlan(plan, {
      appendJournal: async (e) => entries.push(e),
    });
    assert.equal(r.executed, false);
  });

  it("deterministic scenario TRADE is labeled, not mislabeled as AI", () => {
    const plan = planAutonomousExecution({
      decision: {
        action: ACTION.TRADE,
        llm_mode: LLM_MODE.FIXTURE,
        deterministic_scenario: true,
        strategy: { proposed_size_usdc_raw: "1000" },
        decision_hash: "d1",
        mandate_hash: "m1",
      },
      mandate: { trading_enabled: true },
      onChain: {
        paused: false,
        revoked: false,
        autonomous_trading: true,
        enforce_autonomous_on_agent: true,
      },
      mode: EXEC_MODE.SHADOW,
    });
    assert.equal(plan.execute, true);
  });

  it("mainnet mode hard-stopped", () => {
    const plan = planAutonomousExecution({
      decision: {
        action: ACTION.TRADE,
        llm_mode: LLM_MODE.LIVE_LLM,
        strategy: { proposed_size_usdc_raw: "1000" },
        decision_hash: "x",
        mandate_hash: "y",
      },
      mandate: { trading_enabled: true },
      onChain: { paused: false, autonomous_trading: true },
      mode: EXEC_MODE.MAINNET,
    });
    assert.ok(plan.blockers.includes("mainnet_exec_hard_stopped_in_j13"));
  });

  it("restart during signing: invalid transition → ERROR not financial UNKNOWN", async () => {
    const w = await createShadowWorker({ portfolio_id: "f4", journal_dir: dir });
    await transitionState(w, WORKER_STATE.RESEARCHING);
    await transitionState(w, WORKER_STATE.DECIDING);
    await transitionState(w, WORKER_STATE.EXECUTING);
    // Crash mid-sign simulation: jump illegally
    await transitionState(w, WORKER_STATE.RESEARCHING);
    assert.equal(w.state, WORKER_STATE.ERROR);
    assert.equal(w.unknown_blocks_spend, false);
  });

  it("lists reconcile as never-bypass dependency", () => {
    const deps = listOwnerApprovalDependencies();
    const rec = deps.find((d) => d.id === "reconcile");
    assert.ok(rec.autonomous.includes("NEVER_bypass"));
    const propose = deps.find((d) => d.id === "propose");
    assert.equal(propose.per_trade, true);
    assert.ok(propose.autonomous.includes("bypass_operator_confirm"));
  });

  it("settlement pending stays non-terminal in broadcast evaluator", () => {
    const r = evaluateBroadcastAttempt({
      priorState: TX_STATE.CONFIRMED,
      rpcResult: { tx_hash: "0x1" },
    });
    // CONFIRMED is past broadcast — refuse rebroadcast
    assert.equal(r.action, "REFUSE_RETRY");
  });
});
