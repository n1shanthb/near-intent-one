/**
 * J16 — integrity: synthetic receipts fail closed; real-node needs balance delta;
 * UNKNOWN clear requires independent evidence.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  verifySettlementFromReceipt,
  createLocalForkRpc,
  generateLocalForkSigner,
  signEip155WithLocalKey,
} from "./signedTxPipeline.mjs";
import {
  createShadowWorker,
  markUnknownOutcome,
  clearUnknownAfterReconcile,
} from "./worker.mjs";

const TOKEN = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const DEPOSIT = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const MPC = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const AMOUNT = "1000000";
const TRANSFER =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function transferLog() {
  return {
    address: TOKEN,
    topics: [
      TRANSFER,
      "0x" + MPC.replace(/^0x/, "").toLowerCase().padStart(64, "0"),
      "0x" + DEPOSIT.replace(/^0x/, "").toLowerCase().padStart(64, "0"),
    ],
    data: "0x" + BigInt(AMOUNT).toString(16).padStart(64, "0"),
  };
}

describe("J16 integrity gaps", () => {
  it("IN_MEMORY_RPC_SIMULATOR receipt is not independent settlement", () => {
    const fork = createLocalForkRpc({ chainId: 31337, signerAddress: MPC });
    assert.equal(fork.label, "IN_MEMORY_RPC_SIMULATOR");
    const settle = verifySettlementFromReceipt({
      receipt: {
        status: "0x1",
        from: MPC,
        to: TOKEN,
        transactionHash: "0xsim",
        blockHash: "0xb",
        blockNumber: "0x1",
        logs: [transferLog()],
        label: "IN_MEMORY_RPC_SIMULATOR",
        synthetic: true,
      },
      expected: { mpc: MPC, token: TOKEN, depositAddress: DEPOSIT, amount: AMOUNT },
      requireRealNode: true,
      balanceDelta: {
        beforeSender: "2000000",
        afterSender: "1000000",
        beforeDest: "0",
        afterDest: "1000000",
        amount: AMOUNT,
      },
    });
    assert.equal(settle.ok, false);
    assert.equal(settle.reason, "synthetic_receipt_not_independent_settlement");
    assert.equal(settle.financial_readiness, false);
  });

  it("real-node settlement requires balanceDelta", () => {
    const settle = verifySettlementFromReceipt({
      receipt: {
        status: "0x1",
        from: MPC,
        to: TOKEN,
        transactionHash: "0xreal",
        blockHash: "0x" + "ab".repeat(32),
        blockNumber: "0x10",
        from_node: true,
        logs: [transferLog()],
        label: "REAL_EVM_NODE",
      },
      expected: { mpc: MPC, token: TOKEN, depositAddress: DEPOSIT, amount: AMOUNT },
      requireRealNode: true,
    });
    assert.equal(settle.ok, false);
    assert.equal(settle.reason, "balance_delta_required_for_real_node_settlement");
  });

  it("real-node + logs + balanceDelta passes independent verify", () => {
    const settle = verifySettlementFromReceipt({
      receipt: {
        status: "0x1",
        from: MPC,
        to: TOKEN,
        transactionHash: "0xreal2",
        blockHash: "0x" + "cd".repeat(32),
        blockNumber: "0x11",
        from_node: true,
        logs: [transferLog()],
        label: "REAL_EVM_NODE",
      },
      expected: { mpc: MPC, token: TOKEN, depositAddress: DEPOSIT, amount: AMOUNT },
      requireRealNode: true,
      balanceDelta: {
        beforeSender: "1000000000000",
        afterSender: "999999000000",
        beforeDest: "0",
        afterDest: "1000000",
        amount: AMOUNT,
      },
    });
    assert.equal(settle.ok, true);
    assert.equal(settle.independently_verified, true);
    assert.equal(settle.financial_readiness, true);
  });

  it("financial reconcile refuses synthetic settle as independent evidence", async () => {
    const {
      runAutonomousExecution,
      deterministicTradeScenario,
      EXEC_MODE,
    } = await import("./executionService.mjs");
    const { createHash } = await import("node:crypto");
    process.env.NIO_TX_JOURNAL_SECRET = createHash("sha256")
      .update(`j16-ind-${randomBytes(4).toString("hex")}`)
      .digest("hex");
    const signer = generateLocalForkSigner();
    const lockedTx = {
      nonce: 0,
      gasPrice: "1000000000",
      gasLimit: "100000",
      token: TOKEN,
      depositAddress: DEPOSIT,
      amount: AMOUNT,
      chainId: 31337,
      expectedMpc: signer.address,
    };
    const signed = signEip155WithLocalKey({
      privateKeyHex: signer.privateKeyHex,
      ...lockedTx,
    });
    let sawIndependent = null;
    const decision = deterministicTradeScenario({
      strategistSize: AMOUNT,
      fittedSize: AMOUNT,
      destination: DEPOSIT,
      mandateEpoch: 1,
    });
    const trace = await runAutonomousExecution({
      decision,
      mandate: { trading_enabled: true },
      onChain: {
        paused: false,
        revoked: false,
        autonomous_trading: true,
        enforce_autonomous_on_agent: true,
        mandate_epoch: 1,
      },
      quote: {
        amount_in: AMOUNT,
        destination: DEPOSIT,
        asset_in: "USDC",
        stale: false,
      },
      mode: EXEC_MODE.LOCAL_FORK,
      simulateBroadcast: false,
      journalPath: join(tmpdir(), `j16-ind-${Date.now()}.sqlite`),
      lockedTx,
      adapters: {
        propose: async ({ operation_id }) => ({ ok: true, operation_id }),
        assembleSignedRaw: async () => ({
          ok: true,
          signed_raw: signed.rawHex,
          nonce: 0,
          recovered: signed.recovered,
        }),
        broadcast: async () => ({ tx_hash: "0x" + "cd".repeat(32) }),
        settle: async () => ({
          ok: true,
          status: "SETTLED",
          independently_verified: false,
          financial_readiness: false,
          label: "IN_MEMORY_RPC_SIMULATOR",
        }),
        reconcile: async ({ independent_evidence }) => {
          sawIndependent = independent_evidence;
          if (!independent_evidence) {
            return { ok: false, reason: "not_independent" };
          }
          return { ok: true };
        },
      },
    });
    assert.equal(sawIndependent, false);
    assert.equal(trace.ok, false);
    assert.equal(trace.error, "not_independent");
  });

  it("UNKNOWN cannot clear without independent+verified evidence", async () => {
    const w = await createShadowWorker({
      portfolio_id: `j16-u-${randomBytes(2).toString("hex")}`,
      journal_dir: join(tmpdir(), `j16-u-${Date.now()}`),
    });
    await markUnknownOutcome(w, { reason: "ambiguous" });
    await assert.rejects(
      () => clearUnknownAfterReconcile(w, { independent: false, verified: true }),
      /independent/
    );
    await assert.rejects(
      () => clearUnknownAfterReconcile(w, { independent: true, verified: false }),
      /verified/
    );
    await clearUnknownAfterReconcile(w, { independent: true, verified: true });
    assert.equal(w.unknown_blocks_spend, false);
  });
});
