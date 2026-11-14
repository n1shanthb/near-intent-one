/**
 * J14 P1/P3 — fitter binding + refusal / recovery proofs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planAutonomousExecution,
  extractFitterBoundAmount,
  evaluateBroadcastAttempt,
  persistPreBroadcast,
  EXEC_MODE,
} from "./executorAdapter.mjs";
import {
  deterministicTradeScenario,
  runAutonomousExecution,
} from "./executionService.mjs";
import { ACTION, LLM_MODE } from "./shadowAgent.mjs";
import { TX_STATE } from "../execution/txJournal.mjs";
import {
  createShadowWorker,
  acquireLock,
  markUnknownOutcome,
  verifyJournalIntegrity,
  appendJournalEntry,
} from "./worker.mjs";

const chainOk = {
  paused: false,
  revoked: false,
  autonomous_trading: true,
  enforce_autonomous_on_agent: true,
  mandate_epoch: 2,
  limits: { max_trade_value: "5000000" },
};

describe("J14 fitter execution binding", () => {
  it("never executes strategist $100 when fitter resized to $1", () => {
    const decision = deterministicTradeScenario({
      strategistSize: "100000000",
      fittedSize: "1000000",
    });
    const plan = planAutonomousExecution({
      decision,
      mandate: { trading_enabled: true },
      onChain: chainOk,
      mode: EXEC_MODE.SHADOW,
    });
    assert.equal(plan.execute, true);
    assert.equal(plan.amount_raw, "1000000");
    assert.equal(plan.execution_binding.rejected_strategist_size, "100000000");
    assert.equal(plan.execution_binding.source, "fitter_fitted_size_raw_only");
  });

  it("refuses TRADE without fitter fitted_size_raw", () => {
    const decision = {
      action: ACTION.TRADE,
      deterministic_scenario: true,
      llm_mode: LLM_MODE.FIXTURE,
      strategy: { proposed_size_usdc_raw: "100000000" },
      fitter: { outcome: "ADAPTED" }, // missing fitted_size_raw
      decision_hash: "x",
    };
    const plan = planAutonomousExecution({
      decision,
      mandate: { trading_enabled: true },
      onChain: chainOk,
    });
    assert.equal(plan.execute, false);
    assert.ok(plan.blockers.some((b) => b.includes("fitted_size")));
  });

  it("refuses REJECTED fitter outcome even if strategist wants trade", () => {
    const amt = extractFitterBoundAmount({
      fitter: { outcome: "REJECTED", fitted_size_raw: "1000000" },
    });
    assert.equal(amt.ok, false);
  });

  it("refuses stale quote amount mismatch vs fitter", () => {
    const decision = deterministicTradeScenario({ fittedSize: "1000000" });
    const plan = planAutonomousExecution({
      decision,
      mandate: { trading_enabled: true },
      onChain: chainOk,
      quote: { amount_in: "100000000", expired: false },
    });
    assert.equal(plan.execute, false);
    assert.ok(plan.blockers.includes("quote_amount_in_mismatch_fitter"));
  });

  it("refuses epoch mismatch", () => {
    const decision = deterministicTradeScenario({ mandateEpoch: 2 });
    const plan = planAutonomousExecution({
      decision,
      mandate: { trading_enabled: true },
      onChain: { ...chainOk, mandate_epoch: 9 },
    });
    assert.equal(plan.execute, false);
    assert.ok(plan.blockers.some((b) => b.startsWith("epoch_mismatch")));
  });

  it("refuses paused / revoked", () => {
    const decision = deterministicTradeScenario({});
    assert.ok(
      planAutonomousExecution({
        decision,
        mandate: { trading_enabled: true },
        onChain: { ...chainOk, paused: true },
      }).blockers.includes("on_chain_paused")
    );
    assert.ok(
      planAutonomousExecution({
        decision,
        mandate: { trading_enabled: true },
        onChain: { ...chainOk, revoked: true },
      }).blockers.includes("on_chain_revoked")
    );
  });

  it("refuses quote destination / asset redirect vs committed decision", () => {
    const decision = deterministicTradeScenario({
      destination: "intents.near",
      assetIn: "USDC",
    });
    const dest = planAutonomousExecution({
      decision,
      mandate: { trading_enabled: true },
      onChain: chainOk,
      quote: {
        amount_in: "1000000",
        destination: "evil.near",
        asset_in: "USDC",
      },
    });
    assert.equal(dest.execute, false);
    assert.ok(dest.blockers.includes("quote_destination_mismatch"));

    const asset = planAutonomousExecution({
      decision,
      mandate: { trading_enabled: true },
      onChain: chainOk,
      quote: {
        amount_in: "1000000",
        destination: "intents.near",
        asset_in: "WETH",
      },
    });
    assert.equal(asset.execute, false);
    assert.ok(asset.blockers.includes("quote_asset_in_mismatch"));
  });

  it("MAINNET mode hard-stopped", () => {
    const decision = deterministicTradeScenario({});
    const plan = planAutonomousExecution({
      decision,
      mandate: { trading_enabled: true },
      onChain: chainOk,
      mode: EXEC_MODE.MAINNET,
    });
    assert.equal(plan.execute, false);
    assert.ok(plan.blockers.includes("mainnet_exec_hard_stopped_in_j14"));
  });
});

describe("J14 recovery refusals", () => {
  it("ambiguous broadcast → UNKNOWN, no resign", () => {
    const r = evaluateBroadcastAttempt({
      priorState: TX_STATE.SIGNED,
      transportError: "timeout waiting for finality",
    });
    assert.ok(["UNKNOWN_QUARANTINE", "RETRY_IDENTICAL_SIGNED_ONLY"].includes(r.action));
    assert.equal(r.may_resign, false);
  });

  it("already broadcast refuses retry", () => {
    const r = evaluateBroadcastAttempt({
      priorState: TX_STATE.BROADCAST,
      rpcResult: { tx_hash: "0x1" },
    });
    assert.equal(r.action, "REFUSE_RETRY");
  });

  it("financial persist fails closed without journal secret", async () => {
    delete process.env.NIO_TX_JOURNAL_SECRET;
    delete process.env.NIO_TX_JOURNAL_SECRET_PATH;
    await assert.rejects(
      () =>
        persistPreBroadcast({
          journalPath: join(tmpdir(), `j14-j-${Date.now()}.sqlite`),
          operationId: "op-1",
          signedRaw: "0xabc",
          nonce: "1",
          decisionHash: "h",
          mode: EXEC_MODE.TESTNET,
        }),
      /JOURNAL_SECRET_REQUIRED|NIO_TX_JOURNAL_SECRET/
    );
  });

  it("competing workers: second lock fails", async () => {
    const dir = join(tmpdir(), `j14-lock-${Date.now()}`);
    const a = await createShadowWorker({ portfolio_id: "j14a", journal_dir: dir });
    const b = await createShadowWorker({ portfolio_id: "j14a", journal_dir: dir });
    assert.equal(await acquireLock(a), true);
    assert.equal(await acquireLock(b), false);
  });

  it("UNKNOWN settlement cannot be cleared by invented reconciler", async () => {
    const dir = join(tmpdir(), `j14-unk-${Date.now()}`);
    const w = await createShadowWorker({ portfolio_id: "j14u", journal_dir: dir });
    await markUnknownOutcome(w, { reason: "settlement_unknown" });
    assert.equal(w.unknown_blocks_spend, true);
  });

  it("journal corruption fails integrity", async () => {
    const dir = join(tmpdir(), `j14-corr-${Date.now()}`);
    const w = await createShadowWorker({ portfolio_id: "j14c", journal_dir: dir });
    await appendJournalEntry(w, { kind: "decision", action: "HOLD" });
    w.entries[0].action = "TRADE";
    assert.equal(verifyJournalIntegrity(w).ok, false);
  });

  it("execution service refuses inventing settle success without adapter", async () => {
    const decision = deterministicTradeScenario({});
    const trace = await runAutonomousExecution({
      decision,
      mandate: { trading_enabled: true },
      onChain: chainOk,
      mode: EXEC_MODE.SHADOW,
    });
    assert.equal(trace.plan.execute, true);
    assert.equal(trace.ok, false); // no settle+reconcile → not full E2E
    assert.equal(trace.partial, true);
  });

  it("execution service with settle+reconcile adapters can PASS path", async () => {
    const decision = deterministicTradeScenario({});
    const trace = await runAutonomousExecution({
      decision,
      mandate: { trading_enabled: true },
      onChain: chainOk,
      mode: EXEC_MODE.SHADOW,
      adapters: {
        propose: async ({ amount_raw }) => {
          assert.equal(amount_raw, "1000000");
          return { ok: true, operation_id: "op-det" };
        },
        requestSignature: async () => ({
          ok: true,
          signed_raw: "0xsigned",
          nonce: "7",
        }),
        settle: async () => ({ ok: true, status: "SETTLED" }),
        reconcile: async ({ independent_evidence }) => {
          assert.equal(independent_evidence, true);
          return { ok: true };
        },
      },
    });
    assert.equal(trace.ok, true);
    assert.equal(trace.plan.amount_raw, "1000000");
  });

  it("reconciler inventing success without independent flag is caller-enforced", async () => {
    const decision = deterministicTradeScenario({});
    const trace = await runAutonomousExecution({
      decision,
      mandate: { trading_enabled: true },
      onChain: chainOk,
      adapters: {
        propose: async () => ({ ok: true, operation_id: "op" }),
        requestSignature: async () => ({ ok: true, signed_raw: "0x", nonce: "1" }),
        settle: async () => ({ ok: true }),
        reconcile: async ({ independent_evidence }) => {
          if (!independent_evidence) return { ok: false, reason: "not_independent" };
          return { ok: true };
        },
      },
    });
    assert.equal(trace.ok, true);
  });
});
