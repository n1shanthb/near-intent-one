/**
 * J17 — DETERMINISTIC_TESTNET_SAFETY fixtures (labeled; no live broadcast).
 * Covers: restart UNKNOWN preservation, nonce/replay refuse, pause/revoke stop,
 * no duplicate transfer after broadcast.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  evaluateBroadcastAttempt,
  planAutonomousExecution,
  EXEC_MODE,
} from "./executorAdapter.mjs";
import { deterministicTradeScenario } from "./executionService.mjs";
import { TX_STATE } from "../execution/txJournal.mjs";
import {
  createShadowWorker,
  appendJournalEntry,
  acquireLock,
  releaseLock,
  markUnknownOutcome,
  verifyJournalIntegrity,
  replayJournal,
} from "./worker.mjs";

const LABEL = "DETERMINISTIC_TESTNET_SAFETY";

describe(`J17 ${LABEL}`, () => {
  it("ambiguous broadcast → UNKNOWN, may_resign false (no blind resign)", () => {
    const r = evaluateBroadcastAttempt({
      priorState: TX_STATE.SIGNED,
      transportError: "timeout waiting for sepolia finality",
    });
    assert.equal(r.may_resign, false);
    assert.ok(
      ["UNKNOWN_QUARANTINE", "RETRY_IDENTICAL_SIGNED_ONLY"].includes(r.action)
    );
  });

  it("already broadcast refuses second send / resign", () => {
    const r = evaluateBroadcastAttempt({
      priorState: TX_STATE.BROADCAST,
      rpcResult: { tx_hash: "0xabc" },
    });
    assert.equal(r.action, "REFUSE_RETRY");
    assert.equal(r.may_resign, false);
  });

  it("nonce replay / duplicate hash refuses retry", () => {
    const r = evaluateBroadcastAttempt({
      priorState: TX_STATE.SIGNED,
      rpcResult: { error: "nonce too low" },
    });
    // Either quarantine or refuse — never resign with new digest
    assert.equal(r.may_resign, false);
  });

  it("pause blocks new financial execution plan", () => {
    const decision = deterministicTradeScenario({ fittedSize: "1000000" });
    const plan = planAutonomousExecution({
      decision,
      mandate: { trading_enabled: true, mandate_epoch: 1 },
      onChain: {
        paused: true,
        revoked: false,
        autonomous_trading: true,
        enforce_autonomous_on_agent: true,
        mandate_epoch: 1,
      },
      quote: {
        amount_in: "1000000",
        destination: decision.destination || decision?.evidence?.destination,
        stale: false,
      },
      mode: EXEC_MODE.TESTNET,
    });
    assert.equal(plan.execute, false);
    assert.ok(plan.blockers.includes("on_chain_paused"));
  });

  it("revoke blocks new financial execution plan", () => {
    const decision = deterministicTradeScenario({ fittedSize: "1000000" });
    const plan = planAutonomousExecution({
      decision,
      mandate: { trading_enabled: true, mandate_epoch: 1 },
      onChain: {
        paused: false,
        revoked: true,
        autonomous_trading: true,
        enforce_autonomous_on_agent: true,
        mandate_epoch: 2,
      },
      mode: EXEC_MODE.TESTNET,
    });
    assert.equal(plan.execute, false);
    assert.ok(plan.blockers.includes("on_chain_revoked"));
  });

  it("restart preserves UNKNOWN and does not duplicate spend", async () => {
    const dir = join(tmpdir(), `j17-restart-${Date.now()}-${randomBytes(2).toString("hex")}`);
    const w1 = await createShadowWorker({
      portfolio_id: "j17-restart",
      journal_dir: dir,
    });
    await acquireLock(w1);
    await appendJournalEntry(w1, {
      kind: "decision",
      action: "NO_TRADE",
      decision_hash: "j17-h1",
      label: LABEL,
    });
    await markUnknownOutcome(w1, {
      reason: "ambiguous_broadcast_fixture",
      label: LABEL,
    });
    await releaseLock(w1);

    const w2 = await createShadowWorker({
      portfolio_id: "j17-restart",
      journal_dir: dir,
    });
    const integrity = verifyJournalIntegrity(w2);
    const replayed = replayJournal(w2);
    assert.equal(integrity.ok, true);
    assert.equal(
      Boolean(w2.unknown_blocks_spend || replayed.unknown_outcome),
      true
    );
  });
});
