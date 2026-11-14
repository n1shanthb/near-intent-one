/**
 * Mission 1 Ethâ†’NEAR executor â€” simulated E2E state machine (zero mainnet mutations).
 */
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  CANARY_STATES,
  CANARY_ATTESTOR_PK,
  getLifecycleState,
} from "./canaryOneShot.mjs";
import {
  auditMission1ProductionPath,
  auditMission1ProductionPathWithRunner,
  verifyMission1Settlement,
  MISSION1_AMOUNT,
  MISSION1_CHAIN_ID,
  MISSION1_TOKEN,
} from "./mission1ExecutionPath.mjs";
import {
  assertMission1RunnerComplete,
  mission1RunnerCapabilities,
  mission1StepPrepareApproval,
  mission1StepQuoteAttest,
  mission1StepVerifyUnpaused,
  mission1StepPropose,
  mission1StepRequestSignature,
  mission1StepPersistSignedRaw,
  mission1StepBroadcast,
  mission1StepSettle,
  mission1StepReconcilePending,
  mission1StepVerifyPaused,
  recordMission1Confirmation,
  chooseMission1GasParams,
  MISSION1_STEP_HANDLERS,
  listMission1RunnerSteps,
} from "./mission1Executor.mjs";
import { openTxJournal, TX_STATE } from "../execution/txJournal.mjs";
import { CANARY_CHAIN_ID, CANARY_TOKEN } from "./canaryOneShot.mjs";

const env = {
  NIO_CANARY_HMAC_SECRET: "m1-e2e-hmac-secret-32bytes-min!!!!",
  NIO_JOURNAL_SECRET: "m1-e2e-journal-secret-32bytes-min!",
};

function limitsOk() {
  return {
    max_slippage_bps: 100,
    max_trade_value: "5000000",
    max_gas_budget: "500000000000000",
    allowed_assets: [
      "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
      "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    ],
    allowed_destinations: ["nishanthb.near", "0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4"],
    allowed_chains: ["near", "eip155:1", "eip155:42161", "eip155:8453"],
  };
}

function fakeQuote({ deposit = "0xdeposit00000000000000000000000000000001", minOut = "994000", deadlineMs = Date.now() + 600_000 } = {}) {
  return {
    ok: true,
    dry: false,
    deposit_address: deposit,
    amount_in: MISSION1_AMOUNT,
    amount_out: "999000",
    min_amount_out: minOut,
    deadline: new Date(deadlineMs).toISOString(),
    quote_hash: "abc",
    one_click_verify: {
      ok: true,
      verified: true,
      quote_hash: "abc",
      escrow_in_signed_hash: true,
    },
    one_click_response: {
      quoteRequest: {},
      quote: {
        depositAddress: deposit,
        amountIn: MISSION1_AMOUNT,
        minAmountOut: minOut,
        deadline: new Date(deadlineMs).toISOString(),
      },
      signature: "ed25519:fake",
    },
  };
}

function fakeAttest(deposit = "0xdeposit00000000000000000000000000000001") {
  const kp = nacl.sign.keyPair();
  const msg = "mission1-attest-test";
  const sig = nacl.sign.detached(Buffer.from(msg, "utf8"), kp.secretKey);
  return {
    ok: true,
    attestation: {
      deposit_address: deposit,
      token_contract: MISSION1_TOKEN,
      amount_in: MISSION1_AMOUNT,
      chain_id: MISSION1_CHAIN_ID,
    },
    signature: `ed25519:${bs58.encode(Buffer.from(sig))}`,
    message_utf8: msg,
    attestation_id: "att-1",
    _kp: kp,
  };
}

describe("Mission1 runner completeness", () => {
  it("lists all required steps and asserts complete", () => {
    const steps = listMission1RunnerSteps();
    assert.ok(steps.includes("quoteAttest"));
    assert.ok(steps.includes("broadcast"));
    assert.ok(steps.includes("settle"));
    assert.ok(steps.includes("reconcilePending"));
    for (const s of steps) {
      assert.equal(typeof MISSION1_STEP_HANDLERS[s], "function");
    }
    const a = assertMission1RunnerComplete();
    assert.equal(a.ok, true);
    assert.equal(a.capabilities.chain_id, 1);
    assert.equal(a.capabilities.independent_of_j8b, true);
    assert.notEqual(a.capabilities.token, CANARY_TOKEN);
    assert.notEqual(MISSION1_CHAIN_ID, CANARY_CHAIN_ID);
  });

  it("auditMission1ProductionPath is NO-GO without runner assert", () => {
    const audit = auditMission1ProductionPath({ env });
    assert.equal(audit.ok, false);
    assert.ok(audit.engineering_gaps.some((g) => /runner_not_asserted/.test(g)));
  });

  it("audit with runner is READY (engineering)", async () => {
    const audit = await auditMission1ProductionPathWithRunner({ env });
    assert.equal(audit.ok, true, JSON.stringify(audit.engineering_gaps));
    assert.ok(audit.production_ready_components.includes("mission1_step_runner_complete"));
  });
});

describe("Mission1 E2E simulated happy path", () => {
  let storeDir;
  let journalDir;
  let journal;
  const dirs = [];

  before(() => {
    storeDir = mkdtempSync(join(tmpdir(), "m1-e2e-store-"));
    journalDir = mkdtempSync(join(tmpdir(), "m1-e2e-j-"));
    dirs.push(storeDir, journalDir);
    journal = openTxJournal({
      path: join(journalDir, "tx.sqlite"),
      secret: env.NIO_JOURNAL_SECRET,
    });
  });

  after(() => {
    try {
      journal.close();
    } catch {
      /* */
    }
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* */
      }
    }
  });

  it("runs PREPARED â†’ RECONCILED with Eth bindings only", async () => {
    const prepared = mission1StepPrepareApproval({
      operationId: "m1-e2e-happy",
      env,
      storeDir,
      ttlMs: 3600_000,
    });
    assert.equal(prepared.ok, true);
    assert.equal(prepared.payload.chain_id, 1);

    const deposit = "0xdeposit00000000000000000000000000000001";
    const attest = fakeAttest(deposit);
    const quoteAttest = await mission1StepQuoteAttest({
      operationId: "m1-e2e-happy",
      env,
      storeDir,
      testHarness: true,
      deps: {
        limits: limitsOk(),
        epoch: 2,
        paused: true,
        ethBal: { ok: true, wei: "600000000000000" },
        usdcBal: { ok: true, raw: "1200535" },
        nearUsdcBefore: "1000",
        storage: { ok: true, registered: true },
        quoteResult: fakeQuote({ deposit }),
        depositAddress: deposit,
        gasPrice: { ok: true, gas_price_wei: "100000000" },
        gasEst: { ok: true, gas_limit: "65000" },
        nonce: 0,
        attestResult: {
          ok: true,
          attestation: attest.attestation,
          signature: attest.signature,
          message_utf8: attest.message_utf8,
        },
        attestor: { secretKey64: attest._kp.secretKey },
        skipPolicySim: true,
        verifyAttestSig: true,
      },
    });
    assert.equal(quoteAttest.ok, true, JSON.stringify(quoteAttest));
    assert.equal(quoteAttest.chain_id, 1);
    assert.equal(quoteAttest.token, MISSION1_TOKEN);
    assert.equal(quoteAttest.near_usdc_before, "1000");

    const unpaused = await mission1StepVerifyUnpaused({
      operationId: "m1-e2e-happy",
      env,
      storeDir,
      deps: { paused: false },
    });
    assert.equal(unpaused.ok, true);

    recordMission1Confirmation("m1-e2e-happy", "propose", { env, storeDir });
    const proposeDry = await mission1StepPropose({
      operationId: "m1-e2e-happy",
      env,
      storeDir,
      invoke: false,
    });
    assert.equal(proposeDry.dry, true);
    const propose = await mission1StepPropose({
      operationId: "m1-e2e-happy",
      env,
      storeDir,
      invoke: true,
      deps: {
        paused: false,
        proposeFn: async () => ({ ok: true, transaction_hash: "near-propose-1" }),
      },
    });
    assert.equal(propose.ok, true);

    recordMission1Confirmation("m1-e2e-happy", "sign", { env, storeDir });
    const sign = await mission1StepRequestSignature({
      operationId: "m1-e2e-happy",
      env,
      storeDir,
      invoke: true,
      deps: {
        paused: false,
        signFn: async () => ({ ok: true, transaction_hash: "near-sign-1" }),
      },
    });
    assert.equal(sign.ok, true);

    const raw =
      "0xf86c808504a817c80082520894deposit00000000000000000000000000000001808025a0" +
      "11".repeat(32) +
      "a0" +
      "22".repeat(32);
    const persist = mission1StepPersistSignedRaw({
      operationId: "m1-e2e-happy",
      signedRawHex: raw,
      env,
      storeDir,
      deps: { journal, journalSecret: env.NIO_JOURNAL_SECRET },
    });
    assert.equal(persist.ok, true, JSON.stringify(persist));
    assert.equal(persist.may_resign, false);

    recordMission1Confirmation("m1-e2e-happy", "broadcast", { env, storeDir });
    const broadcast = await mission1StepBroadcast({
      operationId: "m1-e2e-happy",
      env,
      storeDir,
      invoke: true,
      deps: {
        paused: false,
        journal,
        ethSend: async () => ({ result: "0xbroadcasteddeadbeef" }),
      },
    });
    assert.equal(broadcast.ok, true, JSON.stringify(broadcast));

    const settle = await mission1StepSettle({
      operationId: "m1-e2e-happy",
      env,
      storeDir,
      deps: {
        sourceVerify: { ok: true, status: "CONFIRMED" },
        oneClick: { ok: true, terminal: true, normalized: "SUCCESS" },
        nearVerify: { ok: true, delta: "994000", kind: "nep141" },
      },
    });
    assert.equal(settle.ok, true, JSON.stringify(settle));

    // confirm reconcile on consumed record via raw file patch
    const recPath = join(storeDir, "m1-e2e-happy.json");
    const rec = JSON.parse(readFileSync(recPath, "utf8"));
    rec.operator_confirmations = {
      ...rec.operator_confirmations,
      reconcile: { at: new Date().toISOString() },
    };
    const { writeFileSync } = await import("node:fs");
    writeFileSync(recPath, JSON.stringify(rec, null, 2));

    const recon = await mission1StepReconcilePending({
      operationId: "m1-e2e-happy",
      env,
      storeDir,
      invoke: true,
      deps: {
        reconcileFn: async () => ({ ok: true }),
      },
    });
    assert.equal(recon.ok, true, JSON.stringify(recon));
    assert.equal(recon.stage, CANARY_STATES.RECONCILED);

    const paused = await mission1StepVerifyPaused({ deps: { paused: true } });
    assert.equal(paused.ok, true);
  });
});

describe("Mission1 failure modes", () => {
  let storeDir;
  const dirs = [];
  before(() => {
    storeDir = mkdtempSync(join(tmpdir(), "m1-fail-"));
    dirs.push(storeDir);
  });
  after(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* */
      }
    }
  });

  async function prep(op) {
    mission1StepPrepareApproval({ operationId: op, env, storeDir, ttlMs: 60_000 });
  }

  it("refuses missing NEAR before snapshot (no zero default)", async () => {
    await prep("m1-no-snap");
    const r = await mission1StepQuoteAttest({
      operationId: "m1-no-snap",
      env,
      storeDir,
      testHarness: true,
      deps: {
        limits: limitsOk(),
        epoch: 2,
        paused: true,
        ethBal: { ok: true, wei: "600000000000000" },
        usdcBal: { ok: true, raw: "1000000" },
        nearUsdcBefore: null,
        storage: { ok: true, registered: true },
        quoteResult: fakeQuote(),
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "near_usdc_before_required");
  });

  it("expired quote deadline blocks attest", async () => {
    await prep("m1-expired-q");
    const r = await mission1StepQuoteAttest({
      operationId: "m1-expired-q",
      env,
      storeDir,
      testHarness: true,
      deps: {
        limits: limitsOk(),
        epoch: 2,
        paused: true,
        ethBal: { ok: true, wei: "600000000000000" },
        usdcBal: { ok: true, raw: "1000000" },
        nearUsdcBefore: "0",
        storage: { ok: true, registered: true },
        quoteResult: fakeQuote({ deadlineMs: Date.now() - 1000 }),
        depositAddress: "0xdeposit00000000000000000000000000000001",
        gasPrice: { ok: true, gas_price_wei: "100000000" },
        gasEst: { ok: true, gas_limit: "65000" },
        attestResult: fakeAttest(),
        skipPolicySim: true,
        verifyAttestSig: false,
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "quote_deadline_too_soon_or_expired");
  });

  it("wrong chain / token rejected at attest", async () => {
    await prep("m1-wrong-chain");
    const bad = fakeAttest();
    bad.attestation.token_contract = CANARY_TOKEN;
    bad.attestation.chain_id = CANARY_CHAIN_ID;
    const r = await mission1StepQuoteAttest({
      operationId: "m1-wrong-chain",
      env,
      storeDir,
      testHarness: true,
      deps: {
        limits: limitsOk(),
        epoch: 2,
        paused: true,
        ethBal: { ok: true, wei: "600000000000000" },
        usdcBal: { ok: true, raw: "1000000" },
        nearUsdcBefore: "0",
        storage: { ok: true, registered: true },
        quoteResult: fakeQuote(),
        depositAddress: "0xdeposit00000000000000000000000000000001",
        gasPrice: { ok: true, gas_price_wei: "100000000" },
        gasEst: { ok: true, gas_limit: "65000" },
        nonce: 0,
        attestResult: bad,
        skipPolicySim: true,
        verifyAttestSig: false,
      },
    });
    assert.equal(r.ok, false);
    assert.ok(["wrong_token", "wrong_chain"].includes(r.reason));
  });

  it("TLS/quote failure surfaces", async () => {
    await prep("m1-tls");
    const r = await mission1StepQuoteAttest({
      operationId: "m1-tls",
      env,
      storeDir,
      testHarness: true,
      deps: {
        limits: limitsOk(),
        epoch: 2,
        paused: true,
        ethBal: { ok: true, wei: "600000000000000" },
        usdcBal: { ok: true, raw: "1000000" },
        nearUsdcBefore: "0",
        storage: { ok: true, registered: true },
        quoteResult: { ok: false, reason: "quote_tls_error" },
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "quote_failed");
  });

  it("duplicate propose refused", async () => {
    await prep("m1-dup-propose");
    const deposit = "0xdeposit00000000000000000000000000000001";
    await mission1StepQuoteAttest({
      operationId: "m1-dup-propose",
      env,
      storeDir,
      testHarness: true,
      deps: {
        limits: limitsOk(),
        epoch: 2,
        paused: true,
        ethBal: { ok: true, wei: "600000000000000" },
        usdcBal: { ok: true, raw: "1000000" },
        nearUsdcBefore: "0",
        storage: { ok: true, registered: true },
        quoteResult: fakeQuote({ deposit }),
        depositAddress: deposit,
        gasPrice: { ok: true, gas_price_wei: "100000000" },
        gasEst: { ok: true, gas_limit: "65000" },
        nonce: 0,
        attestResult: fakeAttest(deposit),
        skipPolicySim: true,
        verifyAttestSig: false,
      },
    });
    await mission1StepVerifyUnpaused({
      operationId: "m1-dup-propose",
      env,
      storeDir,
      deps: { paused: false },
    });
    recordMission1Confirmation("m1-dup-propose", "propose", { env, storeDir });
    await mission1StepPropose({
      operationId: "m1-dup-propose",
      env,
      storeDir,
      invoke: true,
      deps: {
        paused: false,
        proposeFn: async () => ({ ok: true, transaction_hash: "p1" }),
      },
    });
    const again = await mission1StepPropose({
      operationId: "m1-dup-propose",
      env,
      storeDir,
      invoke: true,
      deps: {
        paused: false,
        proposeFn: async () => ({ ok: true, transaction_hash: "p2" }),
      },
    });
    assert.equal(again.ok, false);
    assert.equal(again.reason, "already_proposed_no_resubmit");
  });

  it("mpc digest mismatch blocks sign completion", async () => {
    await prep("m1-bad-digest");
    const deposit = "0xdeposit00000000000000000000000000000001";
    await mission1StepQuoteAttest({
      operationId: "m1-bad-digest",
      env,
      storeDir,
      testHarness: true,
      deps: {
        limits: limitsOk(),
        epoch: 2,
        paused: true,
        ethBal: { ok: true, wei: "600000000000000" },
        usdcBal: { ok: true, raw: "1000000" },
        nearUsdcBefore: "0",
        storage: { ok: true, registered: true },
        quoteResult: fakeQuote({ deposit }),
        depositAddress: deposit,
        gasPrice: { ok: true, gas_price_wei: "100000000" },
        gasEst: { ok: true, gas_limit: "65000" },
        nonce: 0,
        attestResult: fakeAttest(deposit),
        skipPolicySim: true,
        verifyAttestSig: false,
      },
    });
    await mission1StepVerifyUnpaused({
      operationId: "m1-bad-digest",
      env,
      storeDir,
      deps: { paused: false },
    });
    recordMission1Confirmation("m1-bad-digest", "propose", { env, storeDir });
    await mission1StepPropose({
      operationId: "m1-bad-digest",
      env,
      storeDir,
      invoke: true,
      deps: {
        paused: false,
        proposeFn: async () => ({ ok: true, transaction_hash: "p" }),
      },
    });
    recordMission1Confirmation("m1-bad-digest", "sign", { env, storeDir });
    const r = await mission1StepRequestSignature({
      operationId: "m1-bad-digest",
      env,
      storeDir,
      invoke: true,
      deps: {
        paused: false,
        signFn: async () => ({ ok: true, transaction_hash: "s" }),
        mpcDigestHex: "deadbeef",
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "mpc_digest_mismatch");
  });

  it("UNKNOWN journal blocks automatic rebroadcast", async () => {
    const jdir = mkdtempSync(join(tmpdir(), "m1-unk-"));
    dirs.push(jdir);
    const journal = openTxJournal({
      path: join(jdir, "tx.sqlite"),
      secret: env.NIO_JOURNAL_SECRET,
    });
    await prep("m1-unknown");
    const deposit = "0xdeposit00000000000000000000000000000001";
    await mission1StepQuoteAttest({
      operationId: "m1-unknown",
      env,
      storeDir,
      testHarness: true,
      deps: {
        limits: limitsOk(),
        epoch: 2,
        paused: true,
        ethBal: { ok: true, wei: "600000000000000" },
        usdcBal: { ok: true, raw: "1000000" },
        nearUsdcBefore: "0",
        storage: { ok: true, registered: true },
        quoteResult: fakeQuote({ deposit }),
        depositAddress: deposit,
        gasPrice: { ok: true, gas_price_wei: "100000000" },
        gasEst: { ok: true, gas_limit: "65000" },
        nonce: 0,
        attestResult: fakeAttest(deposit),
        skipPolicySim: true,
        verifyAttestSig: false,
      },
    });
    await mission1StepVerifyUnpaused({
      operationId: "m1-unknown",
      env,
      storeDir,
      deps: { paused: false },
    });
    recordMission1Confirmation("m1-unknown", "propose", { env, storeDir });
    await mission1StepPropose({
      operationId: "m1-unknown",
      env,
      storeDir,
      invoke: true,
      deps: {
        paused: false,
        proposeFn: async () => ({ ok: true, transaction_hash: "p" }),
      },
    });
    recordMission1Confirmation("m1-unknown", "sign", { env, storeDir });
    await mission1StepRequestSignature({
      operationId: "m1-unknown",
      env,
      storeDir,
      invoke: true,
      deps: {
        paused: false,
        signFn: async () => ({ ok: true, transaction_hash: "s" }),
      },
    });
    const raw =
      "0xf86c808504a817c80082520894deposit00000000000000000000000000000001808025a0" +
      "11".repeat(32) +
      "a0" +
      "22".repeat(32);
    mission1StepPersistSignedRaw({
      operationId: "m1-unknown",
      signedRawHex: raw,
      env,
      storeDir,
      deps: { journal, journalSecret: env.NIO_JOURNAL_SECRET },
    });
    journal.beginBroadcast("m1-unknown");
    journal.markUnknown("m1-unknown", { rpc_error: "timeout" });
    recordMission1Confirmation("m1-unknown", "broadcast", { env, storeDir });
    const r = await mission1StepBroadcast({
      operationId: "m1-unknown",
      env,
      storeDir,
      invoke: true,
      deps: {
        paused: false,
        journal,
        ethSend: async () => ({ result: "0xshouldnot" }),
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "journal_unknown_requires_reconcile");
    assert.equal(r.may_rebroadcast_identical, false);
    journal.close();
  });

  it("insufficient NEAR delta keeps SETTLEMENT_PENDING", async () => {
    const r = await verifyMission1Settlement({
      txHash: "0x1",
      depositAddress: "0xd",
      minAmountOut: "990000",
      nearUsdcBefore: "1000",
      nearRpcUrl: "https://rpc.mainnet.near.org",
      deps: {
        sourceVerify: { ok: true },
        oneClick: { ok: true, terminal: true, normalized: "SUCCESS" },
        nearVerify: { ok: false, delta: "1" },
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "near_usdc_delta_insufficient");
  });

  it("missing near before refuses settle helper zero-default", async () => {
    const r = await verifyMission1Settlement({
      txHash: "0x1",
      depositAddress: "0xd",
      minAmountOut: "990000",
      nearUsdcBefore: null,
      deps: {
        sourceVerify: { ok: true },
        oneClick: { ok: true, terminal: true, normalized: "SUCCESS" },
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "near_usdc_before_missing_refuse_zero_default");
  });

  it("gas ceiling blocks disproportionate params", () => {
    const g = chooseMission1GasParams({
      liveGasPriceWei: "6000000000", // 6 gwei > 5 gwei ceiling
      gasLimit: "65000",
      ethBalanceWei: "1000000000000000",
    });
    assert.equal(g.ok, false);
  });

  it("approval expiry blocks validation", async () => {
    mission1StepPrepareApproval({
      operationId: "m1-ttl",
      env,
      storeDir,
      ttlMs: 1,
    });
    await new Promise((r) => setTimeout(r, 5));
    const { validateMission1CanaryApproval } = await import("./mission1ExecutionPath.mjs");
    const v = validateMission1CanaryApproval("m1-ttl", { env, storeDir, nowMs: Date.now() + 1000 });
    assert.equal(v.ok, false);
    assert.equal(v.reason, "approval_expired");
  });

  it("operator confirm required before propose", async () => {
    await prep("m1-noconfirm");
    const deposit = "0xdeposit00000000000000000000000000000001";
    await mission1StepQuoteAttest({
      operationId: "m1-noconfirm",
      env,
      storeDir,
      testHarness: true,
      deps: {
        limits: limitsOk(),
        epoch: 2,
        paused: true,
        ethBal: { ok: true, wei: "600000000000000" },
        usdcBal: { ok: true, raw: "1000000" },
        nearUsdcBefore: "0",
        storage: { ok: true, registered: true },
        quoteResult: fakeQuote({ deposit }),
        depositAddress: deposit,
        gasPrice: { ok: true, gas_price_wei: "100000000" },
        gasEst: { ok: true, gas_limit: "65000" },
        nonce: 0,
        attestResult: fakeAttest(deposit),
        skipPolicySim: true,
        verifyAttestSig: false,
      },
    });
    await mission1StepVerifyUnpaused({
      operationId: "m1-noconfirm",
      env,
      storeDir,
      deps: { paused: false },
    });
    const r = await mission1StepPropose({
      operationId: "m1-noconfirm",
      env,
      storeDir,
      invoke: true,
      deps: { paused: false, proposeFn: async () => ({ ok: true }) },
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /operator_confirm_required/);
  });
});

describe("Mission1 capabilities isolate from J8B", () => {
  it("runner capabilities never advertise Arb constants", () => {
    const c = mission1RunnerCapabilities();
    assert.equal(c.chain_id, 1);
    assert.ok(!String(c.asset_in).includes("arb-0x"));
    assert.ok(String(c.asset_out).includes("17208628"));
    assert.equal(c.rejects_j8b_operator, true);
  });
});
