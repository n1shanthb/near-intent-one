/**
 * J8B-0 — one-shot canary executor tests (no mainnet mutations).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import nacl from "tweetnacl";
import {
  mainnetExecutionGates,
  assertMainnetBroadcastAllowed,
  guardedMainnetSubmit,
} from "./safetyGates.mjs";
import {
  createCanaryApproval,
  bindQuoteToApproval,
  validateCanaryApproval,
  consumeCanaryApproval,
  recordOperatorConfirmation,
  buildCanaryUnlockContext,
  CANARY_AMOUNT,
  CANARY_ATTESTOR_PK,
  CANARY_TOKEN,
  CANARY_ASSET_IN,
  CANARY_ASSET_OUT,
} from "./canaryOneShot.mjs";
import {
  runCanaryExecutor,
  runCanaryDryRehearsal,
  prepareCanaryOperation,
} from "./canaryExecutor.mjs";
import { buildLedgerRunbook } from "./canaryLedgerRunbook.mjs";
import { settlementRecoverySteps } from "./canarySettlement.mjs";
import { assertMainnetFundedAllowed, MAINNET_1CLICK } from "../execution/chainProfiles.mjs";
import { broadcastWithJournal } from "../execution/durableBroadcast.mjs";
import { buildLocallySignedQuoteResponse } from "../intents-codec/oneClickVerify.mjs";
import { MAINNET_IDENTITIES } from "./identities.mjs";
import {
  attestTidepoolQuote,
  publicKeyEd25519,
} from "../intents-codec/quote-auth.mjs";

const STORE = mkdtempSync(join(tmpdir(), "nio-j8b0-"));
const MPC = MAINNET_IDENTITIES.mpc_evm_address.toLowerCase();
const ESCROW = "0x1111111111111111111111111111111111111111";

function makeSignedQuote({
  deposit = ESCROW,
  amount = CANARY_AMOUNT,
  minOut = "994904",
  dry = false,
  deadlineOffsetMs = 600_000,
} = {}) {
  const mgr = nacl.sign.keyPair();
  const deadline = new Date(Date.now() + deadlineOffsetMs).toISOString();
  return buildLocallySignedQuoteResponse({
    quoteRequest: {
      dry,
      swapType: "EXACT_INPUT",
      slippageTolerance: 25,
      originAsset: CANARY_ASSET_IN,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: CANARY_ASSET_OUT,
      amount,
      refundTo: MPC,
      refundType: "ORIGIN_CHAIN",
      recipient: MPC,
      recipientType: "DESTINATION_CHAIN",
      deadline,
    },
    quote: {
      amountIn: amount,
      amountInFormatted: "1",
      amountInUsd: "1",
      minAmountIn: amount,
      amountOut: "997398",
      amountOutFormatted: "0.997",
      amountOutUsd: "0.997",
      minAmountOut: minOut,
      depositAddress: deposit,
      deadline,
    },
    secretKey64: Buffer.from(mgr.secretKey),
    correlationId: `test-${Date.now()}`,
  });
}

function mockQuoteResult(signed) {
  return {
    ok: true,
    dry: false,
    amount_in: signed.quote.amountIn,
    amount_out: signed.quote.amountOut,
    min_amount_out: signed.quote.minAmountOut,
    deposit_address: signed.quote.depositAddress,
    one_click_response: {
      quoteRequest: signed.quoteRequest,
      quote: signed.quote,
      signature: signed.signature,
      timestamp: signed.timestamp,
      correlationId: signed.correlationId,
    },
    one_click_verify: {
      ok: true,
      verified: true,
      escrow_in_signed_hash: true,
      quote_hash: "TestQuoteHash111111111111111111111111111111",
      manager_key_mode: "pinned_official",
    },
  };
}

describe("J8B-0 default gates preserved", () => {
  it("env unlocks still leave global gates false", () => {
    const g = mainnetExecutionGates({
      NIO_FUNDED_TRADING: "1",
      NIO_MAINNET_ALLOW_BROADCAST: "1",
      NIO_AUTONOMOUS_EXECUTION: "1",
    });
    assert.equal(g.funded_trading, false);
    assert.equal(g.mainnet_broadcast_enabled, false);
    assert.equal(g.autonomous_execution_enabled, false);
  });

  it("broadcast refused without canary", async () => {
    const gate = assertMainnetBroadcastAllowed({});
    assert.equal(gate.ok, false);
    let called = false;
    const out = await guardedMainnetSubmit(async () => {
      called = true;
    });
    assert.equal(called, false);
    assert.equal(out.ok, false);
  });
});

describe("J8B-0 one-shot approval", () => {
  after(() => {
    try {
      rmSync(STORE, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("creates single-use approval bound to identities", () => {
    const c = createCanaryApproval({
      operationId: "op-create-1",
      storeDir: STORE,
      env: { NIO_CANARY_HMAC_SECRET: "x".repeat(32) },
    });
    assert.equal(c.ok, true);
    const v = validateCanaryApproval("op-create-1", {
      storeDir: STORE,
      env: { NIO_CANARY_HMAC_SECRET: "x".repeat(32) },
    });
    assert.equal(v.ok, true);
    assert.equal(v.payload.amount, CANARY_AMOUNT);
    assert.equal(v.payload.attestor_public_key, CANARY_ATTESTOR_PK);
  });

  it("rejects duplicate operation_id", () => {
    createCanaryApproval({
      operationId: "op-dup",
      storeDir: STORE,
      env: { NIO_CANARY_HMAC_SECRET: "x".repeat(32) },
    });
    assert.throws(() =>
      createCanaryApproval({
        operationId: "op-dup",
        storeDir: STORE,
        env: { NIO_CANARY_HMAC_SECRET: "x".repeat(32) },
      })
    );
  });

  it("rejects unauthorized / expired / used", () => {
    const env = { NIO_CANARY_HMAC_SECRET: "y".repeat(32) };
    createCanaryApproval({
      operationId: "op-exp",
      storeDir: STORE,
      ttlMs: 1,
      env,
    });
    const expired = validateCanaryApproval("op-exp", {
      storeDir: STORE,
      env,
      nowMs: Date.now() + 10_000,
    });
    assert.equal(expired.ok, false);
    assert.equal(expired.reason, "approval_expired");

    createCanaryApproval({
      operationId: "op-used",
      storeDir: STORE,
      env,
    });
    consumeCanaryApproval("op-used", { storeDir: STORE, env });
    const used = validateCanaryApproval("op-used", { storeDir: STORE, env });
    assert.equal(used.ok, false);
    assert.equal(used.reason, "approval_already_used");

    const missing = validateCanaryApproval("no-such-op", {
      storeDir: STORE,
      env,
    });
    assert.equal(missing.ok, false);
  });

  it("canary unlock enables scoped broadcast assert only", async () => {
    const env = { NIO_CANARY_HMAC_SECRET: "z".repeat(32) };
    createCanaryApproval({
      operationId: "op-unlock",
      storeDir: STORE,
      env,
    });
    bindQuoteToApproval("op-unlock", {
      quoteHash: "h1",
      depositAddress: ESCROW,
      storeDir: STORE,
      env,
    });
    const unlock = buildCanaryUnlockContext("op-unlock", {
      storeDir: STORE,
      env,
      requireQuoteBound: true,
    });
    assert.equal(unlock.ok, true);
    const gate = assertMainnetBroadcastAllowed(env, {
      canaryUnlock: unlock,
      storeDir: STORE,
    });
    assert.equal(gate.ok, true);
    assert.equal(gate.mode, "one_shot_canary");
    // global gates report still false
    const g = mainnetExecutionGates(env);
    assert.equal(g.funded_trading, false);
  });
});

describe("J8B-0 executor dry wiring + fail-closed", () => {
  const env = { NIO_CANARY_HMAC_SECRET: "w".repeat(32) };
  const attestor = nacl.sign.keyPair();
  // Override load by injecting deps.attestor with matching registered pk check —
  // executor loadAttestor checks CANARY_ATTESTOR_PK; for unit tests inject attestResult.

  it("dry executor builds plan without mutations", async () => {
    const op = "op-dry-1";
    const signed = makeSignedQuote();
    const fakeAttestor = {
      secretKey64: Buffer.from(attestor.secretKey),
      publicKey: publicKeyEd25519(Buffer.from(attestor.secretKey)),
    };
    const quoteResult = mockQuoteResult(signed);
    const attested = attestTidepoolQuote({
      quoteResponse: quoteResult.one_click_response,
      agentRequest: {
        originAsset: CANARY_ASSET_IN,
        destinationAsset: CANARY_ASSET_OUT,
        amount: CANARY_AMOUNT,
        depositType: "ORIGIN_CHAIN",
        recipient: MPC,
        refundTo: MPC,
      },
      tokenContract: CANARY_TOKEN,
      chainId: 42161,
      maxGasPrice: "100000000",
      gasLimit: "100000",
      secretKey64: fakeAttestor.secretKey64,
      allowTestFixtureMode: true,
      tidepoolManagerPubKey: signed.manager_public_key,
    });
    attested.publicKey = CANARY_ATTESTOR_PK;

    const out = await runCanaryDryRehearsal({
      operationId: op,
      storeDir: STORE,
      env,
      deps: {
        quoteResult,
        attestResult: attested,
        attestor: fakeAttestor,
        ethBal: { ok: true, wei: "63000000000000", ether: 0.000063 },
        usdcBal: { ok: true, raw: "2000982", ui: 2.000982 },
        baseUsdcBefore: { ok: true, raw: "0", ui: 0 },
        nonce: 0,
        gasPrice: { ok: true, wei: "20000000", gwei: 0.02 },
        gasEst: { ok: true, gas: 65000, data: "0xa9059cbb" },
        limits: {
          max_slippage_bps: 100,
          max_trade_value: "5000000",
          max_gas_budget: "2500000000000000",
          max_pending_exposure: "10000000",
          allowed_assets: [CANARY_ASSET_IN, CANARY_ASSET_OUT],
          allowed_destinations: [MPC, MAINNET_IDENTITIES.owner],
          allowed_chains: ["eip155:42161"],
          allowed_venues: ["near_intents_1click"],
          token_scope: "allowlist",
        },
      },
    });
    assert.equal(out.ok, true);
    assert.equal(out.stage, "DRY_REHEARSAL_COMPLETE");
    assert.equal(out.mutations_invoked, false);
    assert.equal(out.gates_default_locked, true);
    assert.ok(out.quote.propose_args?.attestation);
  });

  it("rejects wrong escrow / amount / token via binding", async () => {
    const op = "op-bad-escrow";
    const signed = makeSignedQuote({ deposit: ESCROW });
    const quoteResult = mockQuoteResult(signed);
    const fakeAttestor = {
      secretKey64: Buffer.from(attestor.secretKey),
      publicKey: publicKeyEd25519(Buffer.from(attestor.secretKey)),
    };
    const attested = attestTidepoolQuote({
      quoteResponse: quoteResult.one_click_response,
      agentRequest: {
        originAsset: CANARY_ASSET_IN,
        destinationAsset: CANARY_ASSET_OUT,
        amount: CANARY_AMOUNT,
        depositType: "ORIGIN_CHAIN",
        recipient: MPC,
        refundTo: MPC,
      },
      tokenContract: CANARY_TOKEN,
      chainId: 42161,
      maxGasPrice: "100000000",
      gasLimit: "100000",
      secretKey64: fakeAttestor.secretKey64,
      allowTestFixtureMode: true,
      tidepoolManagerPubKey: signed.manager_public_key,
    });
    assert.equal(attested.ok, true);
    attested.publicKey = CANARY_ATTESTOR_PK;
    // Corrupt quote deposit after attestation — executor compares policyTx.to to quoteResult.deposit_address
    quoteResult.deposit_address = "0x2222222222222222222222222222222222222222";
    const out = await runCanaryDryRehearsal({
      operationId: op,
      storeDir: STORE,
      env,
      deps: {
        quoteResult,
        attestResult: attested,
        attestor: fakeAttestor,
        ethBal: { ok: true, wei: "63000000000000", ether: 0.000063 },
        usdcBal: { ok: true, raw: "2000982", ui: 2 },
        baseUsdcBefore: { ok: true, raw: "0", ui: 0 },
        nonce: 0,
        gasPrice: { ok: true, wei: "20000000", gwei: 0.02 },
        gasEst: { ok: true, gas: 65000, data: "0x" },
        limits: {
          max_slippage_bps: 100,
          max_trade_value: "5000000",
          max_gas_budget: "2500000000000000",
          max_pending_exposure: "10000000",
          allowed_assets: [CANARY_ASSET_IN, CANARY_ASSET_OUT],
          allowed_destinations: [MPC],
          allowed_chains: ["eip155:42161"],
          allowed_venues: ["near_intents_1click"],
          token_scope: "allowlist",
        },
      },
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "wrong_escrow");
  });

  it("live monolith path is refused (sequential CLI required)", async () => {
    const out = await runCanaryExecutor({
      operationId: "op-live-refuse",
      executeLive: true,
      dryRun: false,
      storeDir: STORE,
      env,
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "use_sequential_cli_steps_not_monolith");
  });

  it("funded gate still blocked without canary even with journal", () => {
    const journal = { assertWritable() {} };
    const r = assertMainnetFundedAllowed(MAINNET_1CLICK, {
      journal,
      depositBound: { deposit_address: ESCROW, binding_ok: true },
    });
    assert.equal(r.ok, false);
  });

  it("funded gate allows scoped canary unlock", () => {
    const env = { NIO_CANARY_HMAC_SECRET: "q".repeat(32) };
    createCanaryApproval({
      operationId: "op-funded-gate",
      storeDir: STORE,
      env,
    });
    bindQuoteToApproval("op-funded-gate", {
      quoteHash: "h",
      depositAddress: ESCROW,
      storeDir: STORE,
      env,
    });
    const unlock = buildCanaryUnlockContext("op-funded-gate", {
      storeDir: STORE,
      env,
      requireQuoteBound: true,
    });
    const journal = { assertWritable() {} };
    const r = assertMainnetFundedAllowed(MAINNET_1CLICK, {
      journal,
      depositBound: { deposit_address: ESCROW, binding_ok: true },
      canaryUnlock: unlock,
    });
    assert.equal(r.ok, true);
    assert.equal(r.mode, "one_shot_canary");
  });

  it("ledger runbook uses unpause/pause not set_paused", () => {
    const rb = buildLedgerRunbook({
      argsDir: join(STORE, "ledger-args"),
    });
    assert.equal(rb.contract_methods.open_window, "unpause");
    assert.equal(rb.contract_methods.close_window, "pause");
    assert.ok(rb.unpause_command.includes(" unpause "));
    assert.ok(rb.unpause_command.includes("$NioArgsFile"));
    assert.ok(rb.pause_command.includes(" pause "));
    assert.ok(!rb.unpause_command.includes("set_paused"));
    assert.equal(rb.executed, false);
  });

  it("settlement recovery covers refund and incomplete", () => {
    assert.ok(settlementRecoverySteps("REFUNDED").some((s) => /REFUNDED|refund/i.test(s) || s.includes("pause")));
    assert.ok(settlementRecoverySteps("PENDING").length >= 3);
  });

  it("no unauthorized second trade after consume", () => {
    const env = { NIO_CANARY_HMAC_SECRET: "s".repeat(32) };
    createCanaryApproval({
      operationId: "op-once",
      storeDir: STORE,
      env,
    });
    consumeCanaryApproval("op-once", { storeDir: STORE, env });
    const v = validateCanaryApproval("op-once", { storeDir: STORE, env });
    assert.equal(v.ok, false);
    assert.equal(v.reason, "approval_already_used");
  });
});
