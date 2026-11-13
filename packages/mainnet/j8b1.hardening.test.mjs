/**
 * J8B-1 — sequential canary hardening tests (zero mainnet mutations).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import nacl from "tweetnacl";
import {
  createCanaryApproval,
  bindQuoteToApproval,
  validateCanaryApproval,
  advanceLifecycle,
  confirmPhaseAfterOutcome,
  bindTxAuthorization,
  tryClaimExecution,
  releaseExecutionClaim,
  windowStatusReport,
  CANARY_STATES,
  CANARY_AMOUNT,
  CANARY_ATTESTOR_PK,
  CANARY_TOKEN,
  CANARY_ASSET_IN,
  CANARY_ASSET_OUT,
} from "./canaryOneShot.mjs";
import {
  assertMainnetBroadcastAllowed,
  resolveCanaryUnlock,
  mainnetExecutionGates,
} from "./safetyGates.mjs";
import {
  prepareCanaryOperation,
  canaryStepQuoteAttest,
  canaryStepVerifyUnpaused,
  canaryStepPropose,
  canaryStepRequestSignature,
  canaryStepBroadcast,
  canaryStepSettle,
  canaryStepReconcilePending,
  runCanaryExecutor,
  runCanaryDryRehearsal,
} from "./canaryExecutor.mjs";
import { buildLedgerRunbook } from "./canaryLedgerRunbook.mjs";
import { broadcastWithJournal } from "../execution/durableBroadcast.mjs";
import { openTxJournal, localTxHash } from "../execution/txJournal.mjs";
import { MAINNET_1CLICK } from "../execution/chainProfiles.mjs";
import { buildLocallySignedQuoteResponse } from "../intents-codec/oneClickVerify.mjs";
import { attestTidepoolQuote, publicKeyEd25519 } from "../intents-codec/quote-auth.mjs";
import { MAINNET_IDENTITIES } from "./identities.mjs";

const STORE = mkdtempSync(join(tmpdir(), "nio-j8b1-"));
const ENV = { NIO_CANARY_HMAC_SECRET: "j8b1-secret-key-32bytes-min!!" };
const MPC = MAINNET_IDENTITIES.mpc_evm_address.toLowerCase();
const ESCROW = "0x1111111111111111111111111111111111111111";

function signedQuote() {
  const mgr = nacl.sign.keyPair();
  const deadline = new Date(Date.now() + 600_000).toISOString();
  return buildLocallySignedQuoteResponse({
    quoteRequest: {
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: 25,
      originAsset: CANARY_ASSET_IN,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: CANARY_ASSET_OUT,
      amount: CANARY_AMOUNT,
      refundTo: MPC,
      refundType: "ORIGIN_CHAIN",
      recipient: MPC,
      recipientType: "DESTINATION_CHAIN",
      deadline,
    },
    quote: {
      amountIn: CANARY_AMOUNT,
      amountInFormatted: "1",
      amountInUsd: "1",
      minAmountIn: CANARY_AMOUNT,
      amountOut: "997398",
      amountOutFormatted: "0.997",
      amountOutUsd: "0.997",
      minAmountOut: "994904",
      depositAddress: ESCROW,
      deadline,
    },
    secretKey64: Buffer.from(mgr.secretKey),
    correlationId: `j8b1-${Date.now()}`,
  });
}

function mockQuote(signed) {
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
      quote_hash: "J8b1QuoteHash11111111111111111111111111111",
      manager_key_mode: "pinned_official",
    },
  };
}

function harnessDeps(signed, attestorKp) {
  const quoteResult = mockQuote(signed);
  const attestor = {
    secretKey64: Buffer.from(attestorKp.secretKey),
    publicKey: publicKeyEd25519(Buffer.from(attestorKp.secretKey)),
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
    secretKey64: attestor.secretKey64,
    allowTestFixtureMode: true,
    tidepoolManagerPubKey: signed.manager_public_key,
  });
  attested.publicKey = CANARY_ATTESTOR_PK;
  return {
    quoteResult,
    attestResult: attested,
    attestor,
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
      allowed_destinations: [MPC, MAINNET_IDENTITIES.owner],
      allowed_chains: ["eip155:42161", "eip155:8453"],
      allowed_venues: ["near_intents_1click"],
      token_scope: "allowlist",
    },
  };
}

after(() => {
  try {
    rmSync(STORE, { recursive: true, force: true });
  } catch {
    /* */
  }
});

describe("J8B-1 gates and unlock revalidation", () => {
  it("defaults remain locked", () => {
    const g = mainnetExecutionGates({ NIO_FUNDED_TRADING: "1" });
    assert.equal(g.funded_trading, false);
  });

  it("rejects opaque prevalidated unlock without disk approval", () => {
    const gate = assertMainnetBroadcastAllowed(ENV, {
      canaryUnlock: {
        ok: true,
        mode: "one_shot_canary",
        operation_id: "no-such",
        allows_sign: true,
        allows_broadcast: true,
      },
      storeDir: STORE,
    });
    assert.equal(gate.ok, false);
  });

  it("fresh disk revalidation required for unlock", () => {
    createCanaryApproval({
      operationId: "op-reval",
      storeDir: STORE,
      env: ENV,
    });
    bindQuoteToApproval("op-reval", {
      quoteHash: "h",
      depositAddress: ESCROW,
      storeDir: STORE,
      env: ENV,
    });
    const unlock = resolveCanaryUnlock(
      { operationId: "op-reval", storeDir: STORE, requireQuoteBound: true },
      ENV
    );
    assert.equal(unlock.ok, true);
    assert.equal(unlock.freshly_validated, true);
  });
});

describe("J8B-1 sequential state machine", () => {
  it("refuses monolith live executeLive", async () => {
    const r = await runCanaryExecutor({
      executeLive: true,
      dryRun: false,
      operationId: "x",
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "use_sequential_cli_steps_not_monolith");
  });

  it("quote→attest advances PREPARED→ATTESTED", async () => {
    const attestorKp = nacl.sign.keyPair();
    const signed = signedQuote();
    const prep = await prepareCanaryOperation({
      operationId: "op-seq-1",
      storeDir: STORE,
      env: ENV,
    });
    const q = await canaryStepQuoteAttest({
      operationId: prep.operation_id,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      deps: harnessDeps(signed, attestorKp),
    });
    assert.equal(q.ok, true);
    assert.equal(q.stage, CANARY_STATES.ATTESTED);
    assert.ok(q.propose_args?.attestation);
    const loaded = validateCanaryApproval(prep.operation_id, {
      storeDir: STORE,
      env: ENV,
      requireQuoteBound: true,
    });
    assert.equal(loaded.record.lifecycle_state, CANARY_STATES.ATTESTED);
    assert.equal(loaded.record.locked_nonce, 0);
  });

  it("rejects propose confirm before OWNER_UNPAUSED", () => {
    createCanaryApproval({
      operationId: "op-early-confirm",
      storeDir: STORE,
      env: ENV,
    });
    const c = confirmPhaseAfterOutcome("op-early-confirm", "propose", {
      storeDir: STORE,
      env: ENV,
      requiredState: CANARY_STATES.OWNER_UNPAUSED,
    });
    assert.equal(c.ok, false);
    assert.match(c.reason, /confirm_wrong_state/);
  });

  it("verify-unpaused then propose confirm sequence", async () => {
    const attestorKp = nacl.sign.keyPair();
    const signed = signedQuote();
    await prepareCanaryOperation({
      operationId: "op-unpause-seq",
      storeDir: STORE,
      env: ENV,
    });
    await canaryStepQuoteAttest({
      operationId: "op-unpause-seq",
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      deps: harnessDeps(signed, attestorKp),
    });
    const u = await canaryStepVerifyUnpaused({
      operationId: "op-unpause-seq",
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      deps: { paused: false },
    });
    assert.equal(u.ok, true);
    assert.equal(u.stage, CANARY_STATES.OWNER_UNPAUSED);

    const conf = confirmPhaseAfterOutcome("op-unpause-seq", "propose", {
      storeDir: STORE,
      env: ENV,
      requiredState: CANARY_STATES.OWNER_UNPAUSED,
    });
    assert.equal(conf.ok, true);

    const dryPropose = await canaryStepPropose({
      operationId: "op-unpause-seq",
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      invoke: false,
    });
    assert.equal(dryPropose.ok, true);
    assert.equal(dryPropose.dry, true);
  });

  it("blocks concurrent execution claims", () => {
    createCanaryApproval({
      operationId: "op-claim",
      storeDir: STORE,
      env: ENV,
    });
    const a = tryClaimExecution("op-claim", "worker-a", {
      storeDir: STORE,
      env: ENV,
      ttlMs: 60_000,
    });
    assert.equal(a.ok, true);
    const b = tryClaimExecution("op-claim", "worker-b", {
      storeDir: STORE,
      env: ENV,
      ttlMs: 60_000,
    });
    assert.equal(b.ok, false);
    releaseExecutionClaim("op-claim", "worker-a", { storeDir: STORE, env: ENV });
  });

  it("broadcast rejects missing operationId and malicious unlock-only", async () => {
    const journal = openTxJournal({
      path: join(STORE, "j1.sqlite"),
      secret: "t",
    });
    journal.insertDraft({
      id: "t1",
      portfolio_id: "p",
      idempotency_key: "t1",
      nonce: "0",
      chain_id: "42161",
    });
    journal.markSigned("t1", { signedRawHex: "0xdead" });
    const r = await broadcastWithJournal({
      journal,
      journalId: "t1",
      signedRawHex: "0xdead",
      profile: MAINNET_1CLICK,
      eth: async () => {
        throw new Error("no");
      },
      opts: {
        dryRun: false,
        canaryUnlock: {
          ok: true,
          mode: "one_shot_canary",
          operation_id: "missing",
          allows_sign: true,
          allows_broadcast: true,
        },
        depositBound: { deposit_address: ESCROW, binding_ok: true },
        storeDir: STORE,
        env: ENV,
      },
    });
    assert.equal(r.ok, false);
  });

  it("settlement requires Base USDC delta even if 1Click SUCCESS", async () => {
    createCanaryApproval({
      operationId: "op-settle-base",
      storeDir: STORE,
      env: ENV,
    });
    bindQuoteToApproval("op-settle-base", {
      quoteHash: "h",
      depositAddress: ESCROW,
      storeDir: STORE,
      env: ENV,
    });
    // Fast-forward lifecycle to SETTLEMENT_PENDING with fake broadcast
    for (const s of [
      CANARY_STATES.QUOTE_VERIFIED,
      CANARY_STATES.ATTESTED,
      CANARY_STATES.OWNER_UNPAUSED,
      CANARY_STATES.PROPOSED,
      CANARY_STATES.MPC_SIGNED,
      CANARY_STATES.READY_TO_BROADCAST,
      CANARY_STATES.BROADCASTED,
      CANARY_STATES.SETTLEMENT_PENDING,
    ]) {
      advanceLifecycle("op-settle-base", s, {
        storeDir: STORE,
        env: ENV,
        outcome:
          s === CANARY_STATES.QUOTE_VERIFIED
            ? { min_out: "994904" }
            : s === CANARY_STATES.ATTESTED
              ? { min_out: "994904" }
              : {},
      });
    }
    const loaded = validateCanaryApproval("op-settle-base", {
      storeDir: STORE,
      env: ENV,
      requireQuoteBound: true,
    });
    // Patch broadcast hash + base before via bind helpers
    const { bindBroadcastHash, setBaseUsdcBefore } = await import(
      "./canaryOneShot.mjs"
    );
    bindBroadcastHash("op-settle-base", "0xabc", {
      storeDir: STORE,
      env: ENV,
    });
    setBaseUsdcBefore("op-settle-base", "0", { storeDir: STORE, env: ENV });

    const r = await canaryStepSettle({
      operationId: "op-settle-base",
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      deps: {
        sourceVerify: { ok: true, status: "CONFIRMED" },
        oneClick: {
          ok: true,
          terminal: true,
          normalized: "SUCCESS",
          deposit_address: ESCROW,
        },
        minAmountOut: "994904",
        baseVerify: {
          ok: false,
          delta: "0",
          min_amount_out: "994904",
        },
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "base_usdc_delta_insufficient");
    void loaded;
  });

  it("window status never claims pause without boolean", () => {
    const w = windowStatusReport({
      policyPausedOnchain: null,
      mpcSignatureOutstanding: true,
      broadcastStatus: "unknown",
    });
    assert.equal(w.policy_paused_onchain, "unknown");
    assert.equal(w.owner_pause_required, true);
  });

  it("ledger commands use $NioArgsFile and unpause/pause", () => {
    const rb = buildLedgerRunbook({ argsDir: join(STORE, "ledger") });
    assert.ok(rb.unpause_command.includes("$NioArgsFile"));
    assert.ok(!rb.unpause_command.includes("$ARGS"));
    assert.ok(rb.unpause_command.includes(" unpause "));
    assert.ok(rb.pause_command.includes(" pause "));
  });

  it("dry rehearsal completes without mutations", async () => {
    const attestorKp = nacl.sign.keyPair();
    const signed = signedQuote();
    const r = await runCanaryDryRehearsal({
      operationId: "op-dry-rehearse",
      storeDir: STORE,
      env: ENV,
      deps: harnessDeps(signed, attestorKp),
    });
    assert.equal(r.ok, true);
    assert.equal(r.mutations_invoked, false);
  });

  it("signedRawHex bypass is not accepted by request_signature without MPC assemble", async () => {
    // Sequence to PROPOSED then attempt sign with only signedRawHex dep — adapters missing
    const attestorKp = nacl.sign.keyPair();
    const signed = signedQuote();
    await prepareCanaryOperation({
      operationId: "op-noskip",
      storeDir: STORE,
      env: ENV,
    });
    await canaryStepQuoteAttest({
      operationId: "op-noskip",
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      deps: harnessDeps(signed, attestorKp),
    });
    await canaryStepVerifyUnpaused({
      operationId: "op-noskip",
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      deps: { paused: false },
    });
    confirmPhaseAfterOutcome("op-noskip", "propose", {
      storeDir: STORE,
      env: ENV,
      requiredState: CANARY_STATES.OWNER_UNPAUSED,
    });
    // Manually advance to PROPOSED without real near (simulate successful propose outcome)
    advanceLifecycle("op-noskip", CANARY_STATES.PROPOSED, {
      storeDir: STORE,
      env: ENV,
    });
    confirmPhaseAfterOutcome("op-noskip", "sign", {
      storeDir: STORE,
      env: ENV,
      requiredState: CANARY_STATES.PROPOSED,
    });
    const r = await canaryStepRequestSignature({
      operationId: "op-noskip",
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      invoke: true,
      deps: {
        signedRawHex: "0x" + "ab".repeat(100), // must NOT bypass
      },
    });
    assert.equal(r.ok, false);
    assert.ok(
      r.reason === "near_sign_adapter_missing" ||
        r.reason === "MPC_SIG_NOT_FOUND" ||
        r.reason === "near_finality_pending"
    );
  });

  it("rejects expired quote approval", () => {
    createCanaryApproval({
      operationId: "op-expired",
      storeDir: STORE,
      env: ENV,
      ttlMs: 1,
    });
    const v = validateCanaryApproval("op-expired", {
      storeDir: STORE,
      env: ENV,
      nowMs: Date.now() + 60_000,
    });
    assert.equal(v.ok, false);
    assert.equal(v.reason, "approval_expired");
  });

  it("rejects mandate epoch mismatch at quote step", async () => {
    const attestorKp = nacl.sign.keyPair();
    const signed = signedQuote();
    await prepareCanaryOperation({
      operationId: "op-epoch",
      storeDir: STORE,
      env: ENV,
    });
    const deps = harnessDeps(signed, attestorKp);
    deps.adapters = { getMandateEpoch: async () => 99, getLimits: async () => deps.limits };
    const r = await canaryStepQuoteAttest({
      operationId: "op-epoch",
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      deps,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "mandate_epoch_mismatch");
  });

  it("rejects gas/digest rebind after lock", () => {
    createCanaryApproval({
      operationId: "op-gas-lock",
      storeDir: STORE,
      env: ENV,
    });
    const a = bindTxAuthorization("op-gas-lock", {
      nonce: 1,
      digestHex: "aa".repeat(32),
      gasPrice: "20000000",
      gasLimit: "100000",
      storeDir: STORE,
      env: ENV,
    });
    assert.equal(a.ok, true);
    const b = bindTxAuthorization("op-gas-lock", {
      nonce: 1,
      digestHex: "bb".repeat(32),
      gasPrice: "30000000",
      gasLimit: "100000",
      storeDir: STORE,
      env: ENV,
    });
    assert.equal(b.ok, false);
    assert.equal(b.reason, "digest_already_bound_different");
  });

  it("journal crash recovery refuses resign of different bytes", async () => {
    const journal = openTxJournal({
      path: join(STORE, "crash.sqlite"),
      secret: "t",
    });
    createCanaryApproval({
      operationId: "op-crash",
      storeDir: STORE,
      env: ENV,
    });
    bindQuoteToApproval("op-crash", {
      quoteHash: "h",
      depositAddress: ESCROW,
      storeDir: STORE,
      env: ENV,
    });
    journal.insertDraft({
      id: "op-crash",
      portfolio_id: "p",
      idempotency_key: "op-crash",
      nonce: "0",
      chain_id: "42161",
    });
    const raw1 = "0x" + "11".repeat(80);
    journal.markSigned("op-crash", { signedRawHex: raw1 });
    const r = await broadcastWithJournal({
      journal,
      journalId: "op-crash",
      signedRawHex: "0x" + "22".repeat(80),
      profile: MAINNET_1CLICK,
      eth: async () => ({ result: "0xabc" }),
      opts: {
        dryRun: false,
        operationId: "op-crash",
        depositBound: { deposit_address: ESCROW, binding_ok: true },
        storeDir: STORE,
        env: ENV,
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "signed_bytes_mismatch_no_resign");
  });

  it("pending MPC callback reports outstanding without broadcast", async () => {
    const attestorKp = nacl.sign.keyPair();
    const signed = signedQuote();
    await prepareCanaryOperation({
      operationId: "op-mpc-pend",
      storeDir: STORE,
      env: ENV,
    });
    await canaryStepQuoteAttest({
      operationId: "op-mpc-pend",
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      deps: harnessDeps(signed, attestorKp),
    });
    await canaryStepVerifyUnpaused({
      operationId: "op-mpc-pend",
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      deps: { paused: false },
    });
    confirmPhaseAfterOutcome("op-mpc-pend", "propose", {
      storeDir: STORE,
      env: ENV,
      requiredState: CANARY_STATES.OWNER_UNPAUSED,
    });
    advanceLifecycle("op-mpc-pend", CANARY_STATES.PROPOSED, {
      storeDir: STORE,
      env: ENV,
    });
    confirmPhaseAfterOutcome("op-mpc-pend", "sign", {
      storeDir: STORE,
      env: ENV,
      requiredState: CANARY_STATES.PROPOSED,
    });
    const r = await canaryStepRequestSignature({
      operationId: "op-mpc-pend",
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      invoke: true,
      deps: {
        adapters: {
          requestSignature: async () => ({
            ok: true,
            transaction_hash: "nearTxPending",
          }),
          waitNearTx: async () => null,
        },
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "near_finality_pending");
    assert.equal(r.window.mpc_signature_outstanding, true);
    assert.equal(r.window.broadcast_status, "not_sent");
  });

  it("late settlement stays pending; reconcile is separate confirm", async () => {
    createCanaryApproval({
      operationId: "op-late",
      storeDir: STORE,
      env: ENV,
    });
    bindQuoteToApproval("op-late", {
      quoteHash: "h",
      depositAddress: ESCROW,
      storeDir: STORE,
      env: ENV,
    });
    for (const s of [
      CANARY_STATES.QUOTE_VERIFIED,
      CANARY_STATES.ATTESTED,
      CANARY_STATES.OWNER_UNPAUSED,
      CANARY_STATES.PROPOSED,
      CANARY_STATES.MPC_SIGNED,
      CANARY_STATES.READY_TO_BROADCAST,
      CANARY_STATES.BROADCASTED,
      CANARY_STATES.SETTLEMENT_PENDING,
    ]) {
      advanceLifecycle("op-late", s, {
        storeDir: STORE,
        env: ENV,
        outcome: s === CANARY_STATES.QUOTE_VERIFIED ? { min_out: "994904" } : {},
      });
    }
    const { bindBroadcastHash, setBaseUsdcBefore } = await import(
      "./canaryOneShot.mjs"
    );
    bindBroadcastHash("op-late", "0xlate", { storeDir: STORE, env: ENV });
    setBaseUsdcBefore("op-late", "0", { storeDir: STORE, env: ENV });

    const pending = await canaryStepSettle({
      operationId: "op-late",
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      deps: {
        sourceVerify: { ok: true, status: "CONFIRMED" },
        oneClick: {
          ok: false,
          terminal: false,
          normalized: "PENDING",
          deposit_address: ESCROW,
        },
        minAmountOut: "994904",
      },
    });
    assert.equal(pending.ok, false);
    assert.equal(pending.reason, "settlement_incomplete");

    // Advance to SETTLED manually for reconcile gate test
    advanceLifecycle("op-late", CANARY_STATES.SETTLED, {
      storeDir: STORE,
      env: ENV,
      outcome: { base_delta: "994904" },
    });
    const early = await canaryStepReconcilePending({
      operationId: "op-late",
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      invoke: false,
      evidenceHash: "e".repeat(64),
    });
    // confirm required first — without confirmPhase, confirmPhaseAfterOutcome inside may still write confirm
    // canaryStepReconcilePending calls confirmPhaseAfterOutcome itself
    assert.equal(early.ok, true);
    assert.equal(early.dry, true);

    const live = await canaryStepReconcilePending({
      operationId: "op-late",
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      invoke: true,
      evidenceHash: "e".repeat(64),
      deps: {
        adapters: {
          reconcilePending: async () => ({
            ok: true,
            transaction_hash: "nearReconcile",
            method: "reconcile_pending",
          }),
        },
      },
    });
    assert.equal(live.ok, true);
    assert.equal(live.stage, CANARY_STATES.RECONCILED);
  });

  it("emergency pause window report requires on-chain true", () => {
    const unknown = windowStatusReport({
      policyPausedOnchain: null,
      mpcSignatureOutstanding: false,
      broadcastStatus: "verified",
    });
    assert.equal(unknown.policy_paused_onchain, "unknown");
    assert.equal(unknown.owner_pause_required, true);
    const paused = windowStatusReport({
      policyPausedOnchain: true,
      mpcSignatureOutstanding: false,
      broadcastStatus: "verified",
    });
    assert.equal(paused.policy_paused_onchain, true);
    assert.equal(paused.owner_pause_required, false);
  });
});
