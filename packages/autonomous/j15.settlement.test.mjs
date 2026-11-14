/**
 * J15 — real signed tx / fail-closed / local-fork settlement tests
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  deterministicTradeScenario,
  runAutonomousExecution,
} from "./executionService.mjs";
import { EXEC_MODE } from "./executorAdapter.mjs";
import {
  signEip155WithLocalKey,
  generateLocalForkSigner,
  createLocalForkRpc,
  validateSignedRawAgainstPolicy,
  verifySettlementFromReceipt,
  assembleSignedEvmFromMpc,
} from "./signedTxPipeline.mjs";

const TOKEN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const DEPOSIT = "0x407a7c4013eebd3e5d398a76b8d943c4f49c7100";
const AMOUNT = "1000000";

describe("J15 signed tx pipeline", () => {
  it("recovers local ECDSA signer and builds real EIP-155 raw", () => {
    const signer = generateLocalForkSigner();
    const signed = signEip155WithLocalKey({
      privateKeyHex: signer.privateKeyHex,
      nonce: 0,
      gasPrice: "1000000000",
      gasLimit: "100000",
      token: TOKEN,
      depositAddress: DEPOSIT,
      amount: AMOUNT,
      chainId: 31337,
    });
    assert.equal(signed.ok, true);
    assert.ok(signed.rawHex.startsWith("0x"));
    assert.equal(signed.recovered, signer.address.toLowerCase());
    const v = validateSignedRawAgainstPolicy({
      signedRawHex: signed.rawHex,
      expected: {
        chainId: 31337,
        nonce: 0,
        token: TOKEN,
        mpc: signer.address,
        depositAddress: DEPOSIT,
        amount: AMOUNT,
      },
    });
    assert.equal(v.ok, true);
  });

  it("refuses MPC assemble without near tx / locked params", () => {
    const a = assembleSignedEvmFromMpc({ nearTxFull: null });
    assert.equal(a.ok, false);
  });

  it("local fork broadcast + receipt settle + replay reject", async () => {
    const signer = generateLocalForkSigner();
    const fork = createLocalForkRpc({
      chainId: 31337,
      signerAddress: signer.address,
    });
    const signed = signEip155WithLocalKey({
      privateKeyHex: signer.privateKeyHex,
      nonce: 0,
      gasPrice: "1000000000",
      gasLimit: "100000",
      token: TOKEN,
      depositAddress: DEPOSIT,
      amount: AMOUNT,
      chainId: 31337,
    });
    const send = await fork.eth("eth_sendRawTransaction", [signed.rawHex]);
    assert.ok(send.result);
    const replay = await fork.eth("eth_sendRawTransaction", [signed.rawHex]);
    assert.ok(replay.error);
    const receipt = (await fork.eth("eth_getTransactionReceipt", [send.result]))
      .result;
    const settle = verifySettlementFromReceipt({
      receipt,
      expected: {
        mpc: signer.address,
        token: TOKEN,
        depositAddress: DEPOSIT,
        amount: AMOUNT,
      },
      allowLocalForkLabel: true,
    });
    assert.equal(settle.ok, true);
  });
});

describe("J15 fail-closed financial execution", () => {
  const chainOk = {
    paused: false,
    revoked: false,
    autonomous_trading: true,
    enforce_autonomous_on_agent: true,
    mandate_epoch: 2,
    limits: { max_trade_value: "5000000" },
  };

  it("rejects simulateBroadcast in LOCAL_FORK", async () => {
    const decision = deterministicTradeScenario({
      fittedSize: AMOUNT,
      destination: DEPOSIT,
    });
    const trace = await runAutonomousExecution({
      decision,
      mandate: { trading_enabled: true },
      onChain: chainOk,
      quote: { amount_in: AMOUNT, destination: DEPOSIT, asset_in: "USDC" },
      mode: EXEC_MODE.LOCAL_FORK,
      simulateBroadcast: true,
      journalPath: join(tmpdir(), `j15-${Date.now()}.sqlite`),
      adapters: {
        propose: async () => ({ ok: true, operation_id: "x", amount_raw: AMOUNT }),
        assembleSignedRaw: async () => ({
          ok: true,
          signed_raw: "0x" + "ab".repeat(80),
          nonce: 0,
        }),
        broadcast: async () => ({ tx_hash: "0x1" }),
        settle: async () => ({ ok: true, status: "SETTLED" }),
        reconcile: async () => ({ ok: true }),
      },
    });
    assert.equal(trace.ok, false);
    assert.equal(trace.error, "simulate_broadcast_forbidden_in_financial_mode");
  });

  it("rejects placeholder signed_raw in LOCAL_FORK", async () => {
    process.env.NIO_TX_JOURNAL_SECRET = createHash("sha256")
      .update("j15-test-secret")
      .digest("hex");
    const decision = deterministicTradeScenario({
      fittedSize: AMOUNT,
      destination: DEPOSIT,
    });
    const trace = await runAutonomousExecution({
      decision,
      mandate: { trading_enabled: true },
      onChain: chainOk,
      quote: { amount_in: AMOUNT, destination: DEPOSIT, asset_in: "USDC" },
      mode: EXEC_MODE.LOCAL_FORK,
      simulateBroadcast: false,
      journalPath: join(tmpdir(), `j15p-${Date.now()}.sqlite`),
      adapters: {
        propose: async () => ({
          ok: true,
          operation_id: "op",
          amount_raw: AMOUNT,
        }),
        assembleSignedRaw: async () => ({
          ok: true,
          signed_raw: Buffer.from("TESTNET_MPC_PENDING:fake").toString("hex"),
          nonce: 0,
        }),
        broadcast: async () => ({ tx_hash: "0x1" }),
        settle: async () => ({ ok: true, status: "SETTLED" }),
        reconcile: async () => ({ ok: true }),
      },
    });
    assert.equal(trace.ok, false);
    assert.equal(trace.error, "placeholder_signed_raw_forbidden");
  });

  it("full LOCAL_FORK path PASS with real signed bytes", async () => {
    const signer = generateLocalForkSigner();
    const fork = createLocalForkRpc({
      chainId: 31337,
      signerAddress: signer.address,
    });
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
    process.env.NIO_TX_JOURNAL_SECRET = createHash("sha256")
      .update(`j15-full-${randomBytes(4).toString("hex")}`)
      .digest("hex");
    const decision = deterministicTradeScenario({
      strategistSize: "100000000",
      fittedSize: AMOUNT,
      destination: DEPOSIT,
    });
    const trace = await runAutonomousExecution({
      decision,
      mandate: { trading_enabled: true },
      onChain: chainOk,
      quote: {
        amount_in: AMOUNT,
        destination: DEPOSIT,
        asset_in: "USDC",
        stale: false,
      },
      mode: EXEC_MODE.LOCAL_FORK,
      simulateBroadcast: false,
      journalPath: join(tmpdir(), `j15f-${Date.now()}.sqlite`),
      lockedTx,
      adapters: {
        propose: async ({ amount_raw, operation_id }) => ({
          ok: true,
          operation_id,
          amount_raw,
        }),
        assembleSignedRaw: async () => ({
          ok: true,
          signed_raw: signed.rawHex,
          nonce: 0,
          recovered: signed.recovered,
        }),
        broadcast: async ({ signed_raw }) => {
          const j = await fork.eth("eth_sendRawTransaction", [signed_raw]);
          if (j.error) throw new Error(j.error.message);
          return { tx_hash: j.result };
        },
        settle: async ({ tx_hash }) => {
          const receipt = (await fork.eth("eth_getTransactionReceipt", [tx_hash]))
            .result;
          return verifySettlementFromReceipt({
            receipt,
            expected: {
              mpc: signer.address,
              token: TOKEN,
              depositAddress: DEPOSIT,
              amount: AMOUNT,
            },
            allowLocalForkLabel: true,
          });
        },
        reconcile: async ({ independent_evidence }) => {
          assert.equal(independent_evidence, true);
          return { ok: true, status: "RECONCILED" };
        },
      },
    });
    assert.equal(trace.ok, true);
    assert.equal(trace.label, "LOCAL_FORK");
    assert.equal(trace.plan.amount_raw, AMOUNT);
    assert.equal(trace.plan.execution_binding.rejected_strategist_size, "100000000");
  });
});
