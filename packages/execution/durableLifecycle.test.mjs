/**
 * Crash-injection through real advanceBroadcast + settlement worker with mock RPC.
 * No funded network calls.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openTxJournal, TX_STATE, localTxHash } from "./txJournal.mjs";
import { SEPOLIA_TIDEPOOL, MAINNET_1CLICK, assertProfileIsolation } from "./chainProfiles.mjs";
import { broadcastWithJournal } from "./durableBroadcast.mjs";
import { advanceBroadcast, advanceConfirm } from "../gate-k/settle.mjs";
import { createSettlementWorker } from "../services/settlementWorker.mjs";
import { LIFECYCLE } from "../gate-k/lifecycle.mjs";

function mockStore(executions = {}) {
  const portfolios = {
    p1: {
      portfolio_id: "p1",
      owner_account: "alice.testnet",
      policy_contract: "policy.alice.testnet",
      agent_account: "agent.testnet",
      intents_signer_id: "0x9751874dc251d705ed571a447f7a00de5b845cf4",
      deploy_status: "ready",
    },
  };
  return {
    read: () => ({ executions, portfolios }),
    getPortfolio: (id) => portfolios[id],
    finishExecution(key, patch) {
      executions[key] = { ...(executions[key] || {}), ...patch, key };
    },
  };
}

describe("chain profile isolation", () => {
  it("rejects Sepolia token / Tidepool on mainnet profile", () => {
    assert.throws(
      () =>
        assertProfileIsolation(MAINNET_1CLICK, {
          token: "0x2e6AD9E6D59bB4585ea0E6762c3b637dde29DAD2",
        }),
      /sepolia_token|token_profile/
    );
    assert.throws(
      () =>
        assertProfileIsolation(MAINNET_1CLICK, {
          settleBase: "https://www.usetidepool.tech",
        }),
      /tidepool|settle_endpoint/
    );
  });

  it("accepts Sepolia profile self-consistent fields", () => {
    assert.equal(
      assertProfileIsolation(SEPOLIA_TIDEPOOL, {
        chainId: 11155111,
        token: SEPOLIA_TIDEPOOL.token_usdc,
        settleBase: SEPOLIA_TIDEPOOL.settle_api_base,
      }),
      true
    );
  });
});

describe("durable lifecycle crash injection (mock RPC)", () => {
  let dir;
  let journal;
  const signed = "0xdeadbeefcafe";

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "nio-life-"));
    journal = openTxJournal({
      path: join(dir, "j.sqlite"),
      secret: "crash-injection-secret-key!!",
    });
  });

  after(() => {
    try {
      journal.close();
    } catch {
      /* */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("before sign: DRAFT only — may_resign false after later sign path", () => {
    journal.insertDraft({
      id: "c-before-sign",
      portfolio_id: "p1",
      idempotency_key: "c-before-sign",
      chain_id: "11155111",
    });
    assert.equal(journal.get("c-before-sign").state, TX_STATE.DRAFT);
    assert.equal(journal.loadSignedRaw("c-before-sign"), null);
  });

  it("after signed bytes persisted — crash before broadcast keeps SIGNED", async () => {
    journal.insertDraft({
      id: "c-signed",
      portfolio_id: "p1",
      idempotency_key: "c-signed",
      chain_id: "11155111",
    });
    journal.markSigned("c-signed", { signedRawHex: signed });
    const eth = async () => {
      throw new Error("should_not_broadcast");
    };
    const out = await broadcastWithJournal({
      journal,
      journalId: "c-signed",
      signedRawHex: signed,
      profile: SEPOLIA_TIDEPOOL,
      eth,
      opts: { dryRun: true, workerId: "w1" },
    });
    assert.equal(out.ok, true);
    assert.equal(out.may_resign, false);
    assert.equal(journal.get("c-signed").state, TX_STATE.SIGNED);
  });

  it("during broadcast RPC timeout → UNKNOWN, no resign", async () => {
    journal.insertDraft({
      id: "c-timeout",
      portfolio_id: "p1",
      idempotency_key: "c-timeout",
      chain_id: "11155111",
    });
    journal.markSigned("c-timeout", { signedRawHex: signed });
    const eth = async () => {
      throw new Error("RPC timeout");
    };
    const out = await broadcastWithJournal({
      journal,
      journalId: "c-timeout",
      signedRawHex: signed,
      profile: SEPOLIA_TIDEPOOL,
      eth,
      opts: { dryRun: false, workerId: "w1" },
    });
    assert.equal(out.ok, false);
    assert.equal(out.may_resign, false);
    assert.equal(out.status, TX_STATE.UNKNOWN);
    assert.equal(journal.loadSignedRaw("c-timeout"), signed);
  });

  it("after network accepted — BROADCAST with hash; restart recover", async () => {
    journal.insertDraft({
      id: "c-accept",
      portfolio_id: "p1",
      idempotency_key: "c-accept",
      chain_id: "11155111",
    });
    journal.markSigned("c-accept", { signedRawHex: signed });
    const eth = async () => ({ result: "0xabc123" });
    const out = await broadcastWithJournal({
      journal,
      journalId: "c-accept",
      signedRawHex: signed,
      profile: SEPOLIA_TIDEPOOL,
      eth,
      opts: { dryRun: false, workerId: "w1" },
    });
    assert.equal(out.ok, true);
    assert.equal(out.broadcast_hash, "0xabc123");
    assert.equal(journal.get("c-accept").state, TX_STATE.BROADCAST);
    const rec = journal.recoverOnRestart().find((r) => r.id === "c-accept");
    assert.equal(rec.may_resign, false);
  });

  it("two workers cannot claim same op", () => {
    journal.insertDraft({
      id: "c-claim",
      portfolio_id: "p1",
      idempotency_key: "c-claim",
    });
    journal.markSigned("c-claim", { signedRawHex: signed });
    const a = journal.tryClaim("c-claim", "worker-a", 60_000);
    const b = journal.tryClaim("c-claim", "worker-b", 60_000);
    assert.equal(a.ok, true);
    assert.equal(b.ok, false);
    assert.equal(b.reason, "claimed_by_other");
    journal.releaseClaim("c-claim", "worker-a");
  });

  it("advanceBroadcast refuses mainnet without journal", async () => {
    const out = await advanceBroadcast(
      {
        eth: async () => ({ result: "0x1" }),
        nearRpc: async () => ({ result: {} }),
        rpcUrl: "http://localhost",
        profile: MAINNET_1CLICK,
        journal: null,
      },
      {
        exec: {
          portfolio_id: "p1",
          sign_tx: "nearhash",
          nonce: "1",
          gas_price: "1000000000",
          amount: "1",
          to: "0x1111111111111111111111111111111111111111",
          chain_id: 42161,
          token_contract: MAINNET_1CLICK.token_usdc,
        },
        portfolio: mockStore().getPortfolio("p1"),
      },
      { dryRun: false }
    );
    assert.equal(out.ok, false);
    assert.match(out.reason, /journal_required/);
  });

  it("advanceConfirm requires independent receipt; worker dry-run path", async () => {
    const executions = {
      "gate_k:p1:op1": {
        key: "gate_k:p1:op1",
        kind: "gate_k_ai_trade",
        portfolio_id: "p1",
        status: LIFECYCLE.MPC_SIGNED,
        sign_tx: "near1",
        operation_id: "op1",
        nonce: "7",
        gas_price: "1000000000",
        amount: "1000",
        to: "0x1111111111111111111111111111111111111111",
        chain_id: 11155111,
        token_contract: SEPOLIA_TIDEPOOL.token_usdc,
        journal_id: "c-worker",
      },
    };
    journal.insertDraft({
      id: "c-worker",
      portfolio_id: "p1",
      idempotency_key: "gate_k:p1:op1",
      chain_id: "11155111",
    });
    journal.markSigned("c-worker", { signedRawHex: signed });

    const store = mockStore(executions);
    const worker = createSettlementWorker({
      store,
      eth: async () => ({ result: "0xdead" }),
      nearRpc: async () => ({ result: { receipts_outcome: [] } }),
      rpcUrl: "http://localhost",
      journal,
      profile: SEPOLIA_TIDEPOOL,
      enabled: true,
      dryRun: true,
      workerId: "crash-worker",
    });
    const tick = await worker.tick();
    assert.equal(tick.enabled, true);
    // Without MPC sig in near receipt, broadcast fails closed without resign
    const processed = tick.processed[0];
    assert.ok(processed);
    assert.equal(processed.may_resign, false);
  });

  it("revocation after signed bytes → REVOKED_AFTER_SIGN residual", () => {
    journal.insertDraft({
      id: "c-rev",
      portfolio_id: "p1",
      idempotency_key: "c-rev",
    });
    journal.markSigned("c-rev", { signedRawHex: signed });
    journal.markRevokedAfterSign("c-rev");
    assert.equal(journal.get("c-rev").state, TX_STATE.REVOKED_AFTER_SIGN);
    assert.equal(journal.loadSignedRaw("c-rev"), signed);
  });

  it("quote expiry from DRAFT", () => {
    journal.insertDraft({
      id: "c-exp",
      portfolio_id: "p1",
      idempotency_key: "c-exp",
      quote_deadline_ms: Date.now() - 1,
    });
    journal.markExpired("c-exp");
    assert.equal(journal.get("c-exp").state, TX_STATE.EXPIRED);
  });

  it("identical rebroadcast uses same hash", async () => {
    journal.insertDraft({
      id: "c-re",
      portfolio_id: "p1",
      idempotency_key: "c-re",
    });
    journal.markSigned("c-re", { signedRawHex: signed });
    const h = localTxHash(signed);
    const eth = async (_m, params) => {
      assert.equal(params[0].toLowerCase(), signed.toLowerCase());
      return { result: "0xrebroadcast" };
    };
    // first attempt fails ambiguously then second succeeds with same bytes
    journal.beginBroadcast("c-re");
    journal.db
      .prepare(`UPDATE tx_journal SET state = ?, updated_at = ? WHERE id = ?`)
      .run(TX_STATE.SIGNED, new Date().toISOString(), "c-re");
    const out = await broadcastWithJournal({
      journal,
      journalId: "c-re",
      signedRawHex: signed,
      profile: SEPOLIA_TIDEPOOL,
      eth,
      opts: { dryRun: false, workerId: "w-re" },
    });
    assert.equal(out.local_tx_hash, h);
    assert.equal(out.may_resign, false);
  });
});
