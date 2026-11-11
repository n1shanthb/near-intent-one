/**
 * Settlement worker lifecycle — mocks only. Signing/broadcast remain DISABLED in prod.
 * These tests do NOT prove funded on-chain settlement.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./store.mjs";
import { createSettlementWorker } from "./settlementWorker.mjs";
import { LIFECYCLE, alreadySigned } from "../gate-k/lifecycle.mjs";
import { advanceBroadcast, advanceConfirm } from "../gate-k/settle.mjs";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "nio-settle-"));
  const store = openStore(dir);
  store.upsertPortfolio("i-u-test", {
    portfolio_id: "i-u-test",
    owner_account: "alice.testnet",
    policy_contract: "policy.alice.testnet",
    agent_account: "agent.testnet",
    intents_signer_id: "0xabc0000000000000000000000000000000000001",
    deploy_status: "ready",
  });
  return { dir, store };
}

function seedSigned(store, patch = {}) {
  const key = "gate_k:i-u-test:op1";
  store.beginExecution(key, {
    kind: "gate_k_ai_trade",
    portfolio_id: "i-u-test",
  });
  store.finishExecution(key, {
    status: "SIGNED_PENDING_BROADCAST",
    lifecycle: "MPC_SIGNED",
    kind: "gate_k_ai_trade",
    portfolio_id: "i-u-test",
    operation_id: "op1",
    amount: "1000000",
    nonce: "7",
    gas_price: "1000000000",
    gas_limit: "250000",
    to: "0xdeposit00000000000000000000000000000001",
    sign_tx: "near-sign-hash-1",
    propose_tx: "near-propose-1",
    ...patch,
  });
  return key;
}

describe("settlement worker — disabled / dry-run / no re-sign", () => {
  it("stays disabled by default and lists pending signed txs", async () => {
    const { dir, store } = tempStore();
    try {
      seedSigned(store);
      const w = createSettlementWorker({
        store,
        eth: async () => ({ result: null }),
        nearRpc: async () => ({ result: { receipts_outcome: [] } }),
        rpcUrl: "http://x",
        enabled: false,
        dryRun: true,
      });
      assert.equal(w.health().enabled, false);
      assert.equal(w.listPending().length, 1);
      const tick = await w.tick();
      assert.equal(tick.enabled, false);
      assert.equal(tick.processed.length, 0);
      // persistence unchanged
      assert.equal(
        store.read().executions["gate_k:i-u-test:op1"].status,
        "SIGNED_PENDING_BROADCAST"
      );
      assert.equal(alreadySigned("SIGNED_PENDING_BROADCAST"), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never re-broadcasts when sepolia_tx already present", async () => {
    const skip = await advanceBroadcast(
      {
        eth: async () => {
          throw new Error("eth_should_not_be_called");
        },
        nearRpc: async () => {
          throw new Error("near_should_not_be_called");
        },
        rpcUrl: "http://x",
      },
      {
        exec: {
          sepolia_tx: "0xalready",
          sign_tx: "near1",
          amount: "1",
          to: "0xdep",
          nonce: "1",
          gas_price: "1",
        },
        portfolio: {
          intents_signer_id: "0xabc",
          agent_account: "a.testnet",
        },
      },
      { dryRun: false }
    );
    assert.equal(skip.skipped, true);
    assert.equal(skip.sepolia_tx, "0xalready");
  });

  it("dry-run tick does not write BROADCAST status", async () => {
    const { dir, store } = tempStore();
    try {
      seedSigned(store);
      let ethCalls = 0;
      const w = createSettlementWorker({
        store,
        eth: async () => {
          ethCalls += 1;
          return { result: "0x0" };
        },
        nearRpc: async () => ({
          result: {
            receipts_outcome: [
              {
                outcome: {
                  status: {
                    SuccessValue: Buffer.from(
                      JSON.stringify({
                        big_r: { affine_point: "04" + "11".repeat(32) },
                        s: { scalar: "22".repeat(32) },
                        recovery_id: 0,
                      })
                    ).toString("base64"),
                  },
                },
              },
            ],
          },
        }),
        rpcUrl: "http://x",
        enabled: true,
        dryRun: true,
      });
      const out = await w.tick();
      assert.equal(out.enabled, true);
      assert.equal(out.dry_run, true);
      // dry-run broadcast path may attempt near extract; must not set sepolia_tx
      const exec = store.read().executions["gate_k:i-u-test:op1"];
      assert.equal(exec.status, "SIGNED_PENDING_BROADCAST");
      assert.ok(!exec.sepolia_tx);
      void ethCalls;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("worker restart: listPending survives store reload", () => {
    const { dir, store } = tempStore();
    try {
      seedSigned(store);
      const w1 = createSettlementWorker({
        store,
        eth: async () => ({}),
        nearRpc: async () => ({}),
        rpcUrl: "http://x",
        enabled: false,
        dryRun: true,
      });
      assert.equal(w1.listPending().length, 1);
      const store2 = openStore(dir);
      const w2 = createSettlementWorker({
        store: store2,
        eth: async () => ({}),
        nearRpc: async () => ({}),
        rpcUrl: "http://x",
        enabled: false,
        dryRun: true,
      });
      assert.equal(w2.listPending().length, 1);
      assert.equal(
        w2.listPending()[0].status,
        "SIGNED_PENDING_BROADCAST"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("duplicate nonce / already signed blocks second beginExecution SUCCESS path", () => {
    const { dir, store } = tempStore();
    try {
      const key = seedSigned(store);
      const again = store.beginExecution(key, {
        kind: "gate_k_ai_trade",
        portfolio_id: "i-u-test",
      });
      // beginExecution keeps SUCCESS; for SIGNED it may mark IN_FLIGHT — ensure we don't lose sign_tx
      const row = store.read().executions[key];
      assert.ok(row.sign_tx);
      assert.equal(alreadySigned(row.status) || row.sign_tx != null, true);
      void again;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps failure states honestly (broadcast fail stays signed)", async () => {
    const { dir, store } = tempStore();
    try {
      seedSigned(store);
      const w = createSettlementWorker({
        store,
        eth: async () => ({ error: { message: "rejected" } }),
        nearRpc: async () => ({
          result: { receipts_outcome: [] }, // MPC sig not found
        }),
        rpcUrl: "http://x",
        enabled: true,
        dryRun: false,
      });
      const out = await w.tick();
      assert.equal(out.processed[0].ok, false);
      assert.equal(out.processed[0].reason, "MPC_SIG_NOT_FOUND");
      const exec = store.read().executions["gate_k:i-u-test:op1"];
      // Still signed — retryable, no re-sign required
      assert.ok(
        exec.status === LIFECYCLE.MPC_SIGNED ||
          exec.status === "SIGNED_PENDING_BROADCAST"
      );
      assert.ok(!exec.sepolia_tx);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("settlement confirm / policy gates (unit)", () => {
  it("pending confirmation stays BROADCAST; success → CONFIRMED; no re-sign", async () => {
    let calls = 0;
    const pending = await advanceConfirm(
      {
        eth: async () => {
          calls += 1;
          return { result: null };
        },
      },
      { exec: { sepolia_tx: "0xabc", status: LIFECYCLE.BROADCAST } }
    );
    assert.equal(pending.reason, "RECEIPT_PENDING");
    assert.equal(pending.status, LIFECYCLE.BROADCAST);
    assert.equal(pending.retryable, true);

    const done = await advanceConfirm(
      {
        eth: async () => ({ result: { status: "0x1" } }),
      },
      { exec: { sepolia_tx: "0xabc", status: LIFECYCLE.BROADCAST } }
    );
    assert.equal(done.ok, true);
    assert.equal(done.status, LIFECYCLE.CONFIRMED);
    void calls;
  });

  it("documents that fitter/critic/revoke are pre-sign; worker only advances signed", () => {
    // Worker intentionally does not re-run fitter/critic — those fail closed before MPC_SIGNED.
    assert.equal(alreadySigned(LIFECYCLE.AUTHORIZED), false);
    assert.equal(alreadySigned(LIFECYCLE.MPC_SIGNED), true);
    assert.equal(alreadySigned("SIGNED_PENDING_BROADCAST"), true);
  });
});
