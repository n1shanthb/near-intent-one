/**
 * Mission 2 Base→NEAR executor — simulated E2E + negative/ambiguous (zero mainnet mutations).
 */
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  CANARY_STATES,
  getLifecycleState,
} from "./canaryOneShot.mjs";
import {
  auditMission2ProductionPath,
  auditMission2ProductionPathWithRunner,
  verifyMission2Settlement,
  MISSION2_LIVE_AMOUNT_CAP,
  MISSION2_CHAIN_ID,
  MISSION2_TOKEN,
  assertMission2Bindings,
} from "./mission2ExecutionPath.mjs";
import { MAINNET_USDC } from "./identities.mjs";
import {
  assertMission2RunnerComplete,
  mission2RunnerCapabilities,
  mission2StepPrepareApproval,
  mission2StepQuoteAttest,
  mission2StepVerifyUnpaused,
  mission2StepPropose,
  mission2StepRequestSignature,
  mission2StepPersistSignedRaw,
  mission2StepBroadcast,
  mission2StepSettle,
  mission2StepReconcilePending,
  mission2StepVerifyPaused,
  recordMission2Confirmation,
  chooseMission2GasParams,
  MISSION2_STEP_HANDLERS,
  listMission2RunnerSteps,
  runMission2DryRehearsal,
} from "./mission2Executor.mjs";
import {
  assertMission2FixturesAllowed,
  confirmMission2Phase,
  verifyMission2SignedRaw,
} from "./mission2Safety.mjs";
import { createMission2LiveAdapters } from "./mission2Adapters.mjs";
import { openTxJournal, TX_STATE, localTxHash } from "../execution/txJournal.mjs";
import { CANARY_CHAIN_ID, CANARY_TOKEN } from "./canaryOneShot.mjs";
import { MAINNET_IDENTITIES } from "./identities.mjs";

const env = {
  NIO_CANARY_HMAC_SECRET: "m2-e2e-hmac-secret-32bytes-min!!!!",
  NIO_JOURNAL_SECRET: "m2-e2e-journal-secret-32bytes-min!",
};

const TRADE_AMOUNT = MISSION2_LIVE_AMOUNT_CAP;

function limitsOk() {
  return {
    max_slippage_bps: 100,
    max_trade_value: "5000000",
    max_gas_budget: "500000000000000",
    allowed_assets: [
      "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    ],
    allowed_destinations: ["nishanthb.near", "0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4"],
    allowed_chains: ["near", "eip155:1", "eip155:42161", "eip155:8453"],
  };
}

function fakeQuote({
  deposit = "0xdeposit00000000000000000000000000000001",
  minOut = "994000",
  deadlineMs = Date.now() + 600_000,
} = {}) {
  return {
    ok: true,
    dry: false,
    deposit_address: deposit,
    amount_in: TRADE_AMOUNT,
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
        amountIn: TRADE_AMOUNT,
        minAmountOut: minOut,
        deadline: new Date(deadlineMs).toISOString(),
      },
      signature: "ed25519:fake",
    },
  };
}

function fakeAttest(deposit = "0xdeposit00000000000000000000000000000001") {
  const kp = nacl.sign.keyPair();
  const msg = "mission2-attest-test";
  const sig = nacl.sign.detached(Buffer.from(msg, "utf8"), kp.secretKey);
  return {
    ok: true,
    attestation: {
      deposit_address: deposit,
      token_contract: MISSION2_TOKEN,
      amount_in: TRADE_AMOUNT,
      chain_id: MISSION2_CHAIN_ID,
    },
    signature: `ed25519:${bs58.encode(Buffer.from(sig))}`,
    message_utf8: msg,
    attestation_id: "att-1",
    _kp: kp,
  };
}

function quoteDeps(deposit, extra = {}) {
  return {
    limits: limitsOk(),
    epoch: 2,
    paused: true,
    baseBal: { ok: true, wei: "600000000000000" },
    usdcBal: { ok: true, raw: "997398" },
    nearUsdcBefore: "1000",
    storage: { ok: true, registered: true },
    quoteResult: fakeQuote({ deposit }),
    depositAddress: deposit,
    gasPrice: { ok: true, gas_price_wei: "100000000" },
    gasEst: { ok: true, gas_limit: "65000" },
    nonce: 0,
    attestResult: fakeAttest(deposit),
    skipPolicySim: true,
    verifyAttestSig: false,
    ...extra,
  };
}

const FAKE_RAW =
  "0xf86c808504a817c80082520894deposit00000000000000000000000000000001808025a0" +
  "11".repeat(32) +
  "a0" +
  "22".repeat(32);

describe("Mission2 runner completeness", () => {
  it("lists all required steps and asserts complete", () => {
    const steps = listMission2RunnerSteps();
    assert.ok(steps.includes("quoteAttest"));
    assert.ok(steps.includes("broadcast"));
    assert.ok(steps.includes("settle"));
    assert.ok(steps.includes("reconcilePending"));
    for (const s of steps) {
      assert.equal(typeof MISSION2_STEP_HANDLERS[s], "function");
    }
    const a = assertMission2RunnerComplete();
    assert.equal(a.ok, true);
    assert.equal(a.capabilities.chain_id, 8453);
    assert.equal(a.capabilities.independent_of_j8b, true);
    assert.equal(a.cli_entry, "scripts/mainnet/mission2-operator.mjs");
    assert.ok(existsSync(join(process.cwd(), a.cli_entry)));
    assert.notEqual(a.capabilities.token, CANARY_TOKEN);
    assert.notEqual(MISSION2_CHAIN_ID, CANARY_CHAIN_ID);
  });

  it("auditMission2ProductionPath is NO-GO without runner assert", () => {
    const audit = auditMission2ProductionPath({ env });
    assert.equal(audit.ok, false);
    assert.ok(audit.engineering_gaps.some((g) => /runner_not_asserted/.test(g)));
  });

  it("audit with runner is READY (engineering)", async () => {
    const audit = await auditMission2ProductionPathWithRunner({ env });
    assert.equal(audit.ok, true, JSON.stringify(audit.engineering_gaps));
    assert.ok(
      audit.production_ready_components.includes("mission2_step_runner_complete")
    );
  });

  it("live adapters advertise Base chain and independence from J8B", async () => {
    assert.equal(typeof createMission2LiveAdapters, "function");
    const caps = mission2RunnerCapabilities();
    assert.equal(caps.rejects_eth_operator, true);
    assert.equal(caps.chain_id, 8453);
  });
});

describe("Mission2 E2E simulated happy path", () => {
  let storeDir;
  let journalDir;
  let journal;
  const dirs = [];

  before(() => {
    storeDir = mkdtempSync(join(tmpdir(), "m2-e2e-store-"));
    journalDir = mkdtempSync(join(tmpdir(), "m2-e2e-j-"));
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

  it("runs PREPARED → RECONCILED with Base bindings only", async () => {
    const prepared = mission2StepPrepareApproval({
      operationId: "m2-e2e-happy",
      amount: TRADE_AMOUNT,
      env,
      storeDir,
      ttlMs: 3600_000,
    });
    assert.equal(prepared.ok, true);
    assert.equal(prepared.payload.chain_id, 8453);

    const deposit = "0xdeposit00000000000000000000000000000001";
    const quoteAttest = await mission2StepQuoteAttest({
      operationId: "m2-e2e-happy",
      env,
      storeDir,
      testHarness: true,
      deps: quoteDeps(deposit),
    });
    assert.equal(quoteAttest.ok, true, JSON.stringify(quoteAttest));
    assert.equal(quoteAttest.chain_id, 8453);
    assert.equal(quoteAttest.token, MISSION2_TOKEN);
    const digest = quoteAttest.digest_hex;

    const unpaused = await mission2StepVerifyUnpaused({
      operationId: "m2-e2e-happy",
      env,
      storeDir,
      testHarness: true,
      deps: { paused: false },
    });
    assert.equal(unpaused.ok, true);

    const earlySign = recordMission2Confirmation("m2-e2e-happy", "sign", {
      env,
      storeDir,
    });
    assert.equal(earlySign.ok, false);
    assert.match(earlySign.reason, /confirm_wrong_state/);

    recordMission2Confirmation("m2-e2e-happy", "propose", { env, storeDir });
    const proposeDry = await mission2StepPropose({
      operationId: "m2-e2e-happy",
      env,
      storeDir,
      invoke: false,
      testHarness: true,
    });
    assert.equal(proposeDry.dry, true);

    const pending = {
      payload_commitment: digest,
      signing_state: "Reserved",
      settlement_state: "Pending",
    };
    const propose = await mission2StepPropose({
      operationId: "m2-e2e-happy",
      env,
      storeDir,
      invoke: true,
      testHarness: true,
      deps: {
        paused: false,
        proposeFn: async () => ({ ok: true, transaction_hash: "near-propose-1" }),
        pendingVerify: { ok: true, pending, source: "test" },
      },
    });
    assert.equal(propose.ok, true, JSON.stringify(propose));

    recordMission2Confirmation("m2-e2e-happy", "sign", { env, storeDir });
    const sign = await mission2StepRequestSignature({
      operationId: "m2-e2e-happy",
      env,
      storeDir,
      invoke: true,
      testHarness: true,
      deps: {
        paused: false,
        pendingPreSign: pending,
        pendingPostSign: pending,
        signFn: async () => ({ ok: true, transaction_hash: "near-sign-1" }),
        assembled: {
          ok: true,
          rawHex: FAKE_RAW,
          digest_hex: digest,
          observed_digest_hex: digest,
          recovered: MAINNET_IDENTITIES.mpc_evm_address.toLowerCase(),
        },
        skipSignedRawVerify: true,
      },
    });
    assert.equal(sign.ok, true, JSON.stringify(sign));

    const persist = mission2StepPersistSignedRaw({
      operationId: "m2-e2e-happy",
      signedRawHex: FAKE_RAW,
      env,
      storeDir,
      testHarness: true,
      deps: {
        journal,
        journalSecret: env.NIO_JOURNAL_SECRET,
        skipSignedRawVerify: true,
      },
    });
    assert.equal(persist.ok, true, JSON.stringify(persist));
    assert.equal(persist.may_resign, false);

    recordMission2Confirmation("m2-e2e-happy", "broadcast", { env, storeDir });
    const broadcast = await mission2StepBroadcast({
      operationId: "m2-e2e-happy",
      env,
      storeDir,
      invoke: true,
      testHarness: true,
      deps: {
        paused: false,
        journal,
        nonce: 0,
        pending,
        baseSend: async () => ({ result: "0xbroadcasteddeadbeef" }),
        skipSignedRawVerify: true,
      },
    });
    assert.equal(broadcast.ok, true, JSON.stringify(broadcast));

    const settle = await mission2StepSettle({
      operationId: "m2-e2e-happy",
      env,
      storeDir,
      testHarness: true,
      deps: {
        sourceVerify: { ok: true, status: "CONFIRMED" },
        oneClick: { ok: true, terminal: true, normalized: "SUCCESS" },
        nearVerify: { ok: true, delta: "994000", kind: "nep141" },
      },
    });
    assert.equal(settle.ok, true, JSON.stringify(settle));

    const confRecon = confirmMission2Phase("m2-e2e-happy", "reconcile", {
      env,
      storeDir,
    });
    assert.equal(confRecon.ok, true, JSON.stringify(confRecon));

    const recon = await mission2StepReconcilePending({
      operationId: "m2-e2e-happy",
      env,
      storeDir,
      invoke: true,
      testHarness: true,
      deps: {
        reconcileFn: async () => ({ ok: true, transaction_hash: "near-recon-1" }),
        pendingAfter: {
          ...pending,
          settlement_state: "Success",
        },
        evidenceOnchain: settle.evidence_hash,
        pausedAfter: true,
        nearReceiptVerify: async () => ({ ok: true }),
      },
    });
    assert.equal(recon.ok, true, JSON.stringify(recon));
    assert.equal(recon.stage, CANARY_STATES.RECONCILED);

    const paused = await mission2StepVerifyPaused({
      testHarness: true,
      deps: { paused: true },
    });
    assert.equal(paused.ok, true);
  });
});

describe("Mission2 failure modes", () => {
  let storeDir;
  const dirs = [];
  before(() => {
    storeDir = mkdtempSync(join(tmpdir(), "m2-fail-"));
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
    mission2StepPrepareApproval({
      operationId: op,
      amount: TRADE_AMOUNT,
      env,
      storeDir,
      ttlMs: 60_000,
    });
  }

  async function toUnpaused(op, deposit = "0xdeposit00000000000000000000000000000001") {
    const qa = await mission2StepQuoteAttest({
      operationId: op,
      env,
      storeDir,
      testHarness: true,
      deps: quoteDeps(deposit),
    });
    assert.equal(qa.ok, true, JSON.stringify(qa));
    await mission2StepVerifyUnpaused({
      operationId: op,
      env,
      storeDir,
      testHarness: true,
      deps: { paused: false },
    });
    return qa;
  }

  it("refuses fixture injection without testHarness", async () => {
    await prep("m2-nofixture");
    const r = await mission2StepQuoteAttest({
      operationId: "m2-nofixture",
      env,
      storeDir,
      testHarness: false,
      deps: { paused: true, limits: limitsOk() },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "fixture_injection_requires_testHarness");
  });

  it("assertMission2FixturesAllowed blocks production fixtures", () => {
    const g = assertMission2FixturesAllowed(false, { paused: false });
    assert.equal(g.ok, false);
  });

  it("refuses missing NEAR before snapshot (no zero default)", async () => {
    await prep("m2-no-snap");
    const r = await mission2StepQuoteAttest({
      operationId: "m2-no-snap",
      env,
      storeDir,
      testHarness: true,
      deps: {
        ...quoteDeps("0xdeposit00000000000000000000000000000001"),
        nearUsdcBefore: null,
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "near_usdc_before_required");
  });

  it("expired quote deadline blocks attest", async () => {
    await prep("m2-expired-q");
    const r = await mission2StepQuoteAttest({
      operationId: "m2-expired-q",
      env,
      storeDir,
      testHarness: true,
      deps: {
        ...quoteDeps("0xdeposit00000000000000000000000000000001"),
        quoteResult: fakeQuote({ deadlineMs: Date.now() - 1000 }),
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "quote_deadline_too_soon_or_expired");
  });

  it("wrong chain / token rejected at attest", async () => {
    await prep("m2-wrong-chain");
    const bad = fakeAttest();
    bad.attestation.token_contract = CANARY_TOKEN;
    bad.attestation.chain_id = CANARY_CHAIN_ID;
    const r = await mission2StepQuoteAttest({
      operationId: "m2-wrong-chain",
      env,
      storeDir,
      testHarness: true,
      deps: {
        ...quoteDeps("0xdeposit00000000000000000000000000000001"),
        attestResult: bad,
      },
    });
    assert.equal(r.ok, false);
    assert.ok(["wrong_token", "wrong_chain"].includes(r.reason));
  });

  it("TLS/quote failure surfaces", async () => {
    await prep("m2-tls");
    const r = await mission2StepQuoteAttest({
      operationId: "m2-tls",
      env,
      storeDir,
      testHarness: true,
      deps: {
        ...quoteDeps("0xdeposit00000000000000000000000000000001"),
        quoteResult: { ok: false, reason: "quote_tls_error" },
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "quote_failed");
  });

  it("propose failure does not advance to PROPOSED", async () => {
    await prep("m2-propose-fail");
    await toUnpaused("m2-propose-fail");
    recordMission2Confirmation("m2-propose-fail", "propose", { env, storeDir });
    const r = await mission2StepPropose({
      operationId: "m2-propose-fail",
      env,
      storeDir,
      invoke: true,
      testHarness: true,
      deps: {
        paused: false,
        proposeFn: async () => ({ ok: false, reason: "near_rpc_rejected" }),
      },
    });
    assert.equal(r.ok, false);
    assert.equal(
      getLifecycleState(
        JSON.parse(readFileSync(join(storeDir, "m2-propose-fail.json"), "utf8"))
      ),
      CANARY_STATES.OWNER_UNPAUSED
    );
  });

  it("ambiguous pending blocks resubmit and marks reconciliation", async () => {
    await prep("m2-ambig");
    const qa = await toUnpaused("m2-ambig");
    recordMission2Confirmation("m2-ambig", "propose", { env, storeDir });
    const r = await mission2StepPropose({
      operationId: "m2-ambig",
      env,
      storeDir,
      invoke: true,
      testHarness: true,
      deps: {
        paused: false,
        proposeFn: async () => ({ ok: true, transaction_hash: "near-ambig" }),
        pendingVerify: {
          ok: false,
          reason: "pending_op_temporarily_unverified",
          attempts: 8,
        },
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "reconciliation_required");
    assert.equal(r.may_resubmit, false);
    assert.equal(
      getLifecycleState(
        JSON.parse(readFileSync(join(storeDir, "m2-ambig.json"), "utf8"))
      ),
      CANARY_STATES.RECONCILIATION_REQUIRED
    );
    const again = await mission2StepPropose({
      operationId: "m2-ambig",
      env,
      storeDir,
      invoke: true,
      testHarness: true,
      deps: {
        paused: false,
        proposeFn: async () => ({ ok: true, transaction_hash: "near-ambig-2" }),
        pendingVerify: {
          ok: true,
          pending: { payload_commitment: qa.digest_hex },
        },
      },
    });
    assert.equal(again.ok, false);
    assert.equal(again.reason, "reconciliation_required_no_resubmit");
  });

  it("duplicate propose refused after success", async () => {
    await prep("m2-dup-propose");
    const qa = await toUnpaused("m2-dup-propose");
    recordMission2Confirmation("m2-dup-propose", "propose", { env, storeDir });
    const pending = {
      payload_commitment: qa.digest_hex,
      signing_state: "Reserved",
    };
    await mission2StepPropose({
      operationId: "m2-dup-propose",
      env,
      storeDir,
      invoke: true,
      testHarness: true,
      deps: {
        paused: false,
        proposeFn: async () => ({ ok: true, transaction_hash: "p1" }),
        pendingVerify: { ok: true, pending, source: "test" },
      },
    });
    const again = await mission2StepPropose({
      operationId: "m2-dup-propose",
      env,
      storeDir,
      invoke: true,
      testHarness: true,
      deps: {
        paused: false,
        proposeFn: async () => ({ ok: true, transaction_hash: "p2" }),
        pendingVerify: { ok: true, pending, source: "test" },
      },
    });
    assert.equal(again.ok, false);
    assert.equal(again.reason, "already_proposed_no_resubmit");
  });

  it("mpc digest missing does not default to expected", async () => {
    await prep("m2-bad-digest");
    const qa = await toUnpaused("m2-bad-digest");
    const pending = {
      payload_commitment: qa.digest_hex,
      signing_state: "Reserved",
    };
    recordMission2Confirmation("m2-bad-digest", "propose", { env, storeDir });
    await mission2StepPropose({
      operationId: "m2-bad-digest",
      env,
      storeDir,
      invoke: true,
      testHarness: true,
      deps: {
        paused: false,
        proposeFn: async () => ({ ok: true, transaction_hash: "p" }),
        pendingVerify: { ok: true, pending, source: "test" },
      },
    });
    recordMission2Confirmation("m2-bad-digest", "sign", { env, storeDir });
    const r = await mission2StepRequestSignature({
      operationId: "m2-bad-digest",
      env,
      storeDir,
      invoke: true,
      testHarness: true,
      deps: {
        paused: false,
        pendingPreSign: pending,
        signFn: async () => ({ ok: true, transaction_hash: "s" }),
        // observed digest intentionally omitted — must not fall back to expected
        assembled: { ok: true, rawHex: FAKE_RAW, recovered: "0xee" },
        mpcDigestHex: undefined,
        skipSignedRawVerify: true,
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "mpc_digest_not_observed");
    assert.equal(r.may_repeat_request_signature, false);
  });

  it("mpc digest mismatch blocks sign", async () => {
    await prep("m2-digest-mm");
    const qa = await toUnpaused("m2-digest-mm");
    const pending = {
      payload_commitment: qa.digest_hex,
      signing_state: "Reserved",
    };
    recordMission2Confirmation("m2-digest-mm", "propose", { env, storeDir });
    await mission2StepPropose({
      operationId: "m2-digest-mm",
      env,
      storeDir,
      invoke: true,
      testHarness: true,
      deps: {
        paused: false,
        proposeFn: async () => ({ ok: true, transaction_hash: "p" }),
        pendingVerify: { ok: true, pending, source: "test" },
      },
    });
    recordMission2Confirmation("m2-digest-mm", "sign", { env, storeDir });
    const r = await mission2StepRequestSignature({
      operationId: "m2-digest-mm",
      env,
      storeDir,
      invoke: true,
      testHarness: true,
      deps: {
        paused: false,
        pendingPreSign: pending,
        signFn: async () => ({ ok: true, transaction_hash: "s" }),
        assembled: {
          ok: true,
          rawHex: FAKE_RAW,
          digest_hex: "deadbeef",
          observed_digest_hex: "deadbeef",
        },
        skipSignedRawVerify: true,
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "mpc_digest_mismatch");
    assert.equal(r.may_repeat_request_signature, false);
  });

  it("ambiguous sign finality refuses repeat request_signature", async () => {
    await prep("m2-sign-ambig");
    const qa = await toUnpaused("m2-sign-ambig");
    const pending = {
      payload_commitment: qa.digest_hex,
      signing_state: "Reserved",
    };
    recordMission2Confirmation("m2-sign-ambig", "propose", { env, storeDir });
    await mission2StepPropose({
      operationId: "m2-sign-ambig",
      env,
      storeDir,
      invoke: true,
      testHarness: true,
      deps: {
        paused: false,
        proposeFn: async () => ({ ok: true, transaction_hash: "p" }),
        pendingVerify: { ok: true, pending, source: "test" },
      },
    });
    recordMission2Confirmation("m2-sign-ambig", "sign", { env, storeDir });
    const r = await mission2StepRequestSignature({
      operationId: "m2-sign-ambig",
      env,
      storeDir,
      invoke: true,
      testHarness: true,
      deps: {
        paused: false,
        pendingPreSign: pending,
        signFn: async () => ({ ok: true, transaction_hash: "s" }),
        // no nearTxFull / assembled
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "near_finality_pending");
    assert.equal(r.may_repeat_request_signature, false);
  });

  it("UNKNOWN journal blocks automatic rebroadcast", async () => {
    const jdir = mkdtempSync(join(tmpdir(), "m2-unk-"));
    dirs.push(jdir);
    const journal = openTxJournal({
      path: join(jdir, "tx.sqlite"),
      secret: env.NIO_JOURNAL_SECRET,
    });
    await prep("m2-unknown");
    const qa = await toUnpaused("m2-unknown");
    const pending = {
      payload_commitment: qa.digest_hex,
      signing_state: "Reserved",
    };
    recordMission2Confirmation("m2-unknown", "propose", { env, storeDir });
    await mission2StepPropose({
      operationId: "m2-unknown",
      env,
      storeDir,
      invoke: true,
      testHarness: true,
      deps: {
        paused: false,
        proposeFn: async () => ({ ok: true, transaction_hash: "p" }),
        pendingVerify: { ok: true, pending, source: "test" },
      },
    });
    recordMission2Confirmation("m2-unknown", "sign", { env, storeDir });
    await mission2StepRequestSignature({
      operationId: "m2-unknown",
      env,
      storeDir,
      invoke: true,
      testHarness: true,
      deps: {
        paused: false,
        pendingPreSign: pending,
        pendingPostSign: pending,
        signFn: async () => ({ ok: true, transaction_hash: "s" }),
        assembled: {
          ok: true,
          rawHex: FAKE_RAW,
          digest_hex: qa.digest_hex,
          observed_digest_hex: qa.digest_hex,
        },
        skipSignedRawVerify: true,
      },
    });
    mission2StepPersistSignedRaw({
      operationId: "m2-unknown",
      signedRawHex: FAKE_RAW,
      env,
      storeDir,
      testHarness: true,
      deps: {
        journal,
        journalSecret: env.NIO_JOURNAL_SECRET,
        skipSignedRawVerify: true,
      },
    });
    journal.beginBroadcast("m2-unknown");
    journal.markUnknown("m2-unknown", { rpc_error: "timeout" });
    recordMission2Confirmation("m2-unknown", "broadcast", { env, storeDir });
    const r = await mission2StepBroadcast({
      operationId: "m2-unknown",
      env,
      storeDir,
      invoke: true,
      testHarness: true,
      deps: {
        paused: false,
        journal,
        nonce: 0,
        pending,
        baseSend: async () => ({ result: "0xshouldnot" }),
        skipSignedRawVerify: true,
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "journal_unknown_requires_reconcile");
    assert.equal(r.may_rebroadcast_identical, false);
    journal.close();
  });

  it("expired quote blocks broadcast", async () => {
    const jdir = mkdtempSync(join(tmpdir(), "m2-expb-"));
    dirs.push(jdir);
    const journal = openTxJournal({
      path: join(jdir, "tx.sqlite"),
      secret: env.NIO_JOURNAL_SECRET,
    });
    await prep("m2-exp-bcast");
    const qa = await toUnpaused("m2-exp-bcast");
    const pending = {
      payload_commitment: qa.digest_hex,
      signing_state: "Reserved",
    };
    recordMission2Confirmation("m2-exp-bcast", "propose", { env, storeDir });
    await mission2StepPropose({
      operationId: "m2-exp-bcast",
      env,
      storeDir,
      invoke: true,
      testHarness: true,
      deps: {
        paused: false,
        proposeFn: async () => ({ ok: true, transaction_hash: "p" }),
        pendingVerify: { ok: true, pending, source: "test" },
      },
    });
    recordMission2Confirmation("m2-exp-bcast", "sign", { env, storeDir });
    await mission2StepRequestSignature({
      operationId: "m2-exp-bcast",
      env,
      storeDir,
      invoke: true,
      testHarness: true,
      deps: {
        paused: false,
        pendingPreSign: pending,
        pendingPostSign: pending,
        signFn: async () => ({ ok: true, transaction_hash: "s" }),
        assembled: {
          ok: true,
          rawHex: FAKE_RAW,
          digest_hex: qa.digest_hex,
          observed_digest_hex: qa.digest_hex,
        },
        skipSignedRawVerify: true,
      },
    });
    mission2StepPersistSignedRaw({
      operationId: "m2-exp-bcast",
      signedRawHex: FAKE_RAW,
      env,
      storeDir,
      testHarness: true,
      deps: {
        journal,
        journalSecret: env.NIO_JOURNAL_SECRET,
        skipSignedRawVerify: true,
      },
    });
    // Expire quote deadline in record
    const path = join(storeDir, "m2-exp-bcast.json");
    const rec = JSON.parse(readFileSync(path, "utf8"));
    rec.outcomes[CANARY_STATES.ATTESTED].quote_deadline_ms = Date.now() - 1000;
    writeFileSync(path, JSON.stringify(rec, null, 2));
    recordMission2Confirmation("m2-exp-bcast", "broadcast", { env, storeDir });
    const r = await mission2StepBroadcast({
      operationId: "m2-exp-bcast",
      env,
      storeDir,
      invoke: true,
      testHarness: true,
      deps: {
        paused: false,
        journal,
        nonce: 0,
        pending,
        baseSend: async () => ({ result: "0xno" }),
        skipSignedRawVerify: true,
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "quote_expired_before_broadcast");
    journal.close();
  });

  it("reconcile refuses without Success settlement_state", async () => {
    await prep("m2-recon-bad");
    const qa = await toUnpaused("m2-recon-bad");
    const pending = {
      payload_commitment: qa.digest_hex,
      signing_state: "Reserved",
    };
    // Force SETTLED via raw write after consume-like path
    const path = join(storeDir, "m2-recon-bad.json");
    const rec = JSON.parse(readFileSync(path, "utf8"));
    rec.lifecycle_state = CANARY_STATES.SETTLED;
    rec.used = true;
    rec.outcomes = {
      ...rec.outcomes,
      [CANARY_STATES.SETTLED]: {
        at: new Date().toISOString(),
        evidence_hash: "evhash1",
      },
    };
    writeFileSync(path, JSON.stringify(rec, null, 2));
    confirmMission2Phase("m2-recon-bad", "reconcile", { env, storeDir });
    const r = await mission2StepReconcilePending({
      operationId: "m2-recon-bad",
      env,
      storeDir,
      invoke: true,
      testHarness: true,
      deps: {
        reconcileFn: async () => ({ ok: true }),
        pendingAfter: { ...pending, settlement_state: "Pending" },
        evidenceOnchain: "evhash1",
        pausedAfter: true,
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "settlement_state_not_success");
  });

  it("insufficient NEAR delta keeps SETTLEMENT_PENDING", async () => {
    const r = await verifyMission2Settlement({
      txHash: "0x1",
      depositAddress: "0xd",
      amount: TRADE_AMOUNT,
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
    const r = await verifyMission2Settlement({
      txHash: "0x1",
      depositAddress: "0xd",
      amount: TRADE_AMOUNT,
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
    const g = chooseMission2GasParams({
      liveGasPriceWei: "6000000000",
      gasLimit: "65000",
      ethBalanceWei: "1000000000000000",
    });
    assert.equal(g.ok, false);
  });

  it("approval expiry blocks validation", async () => {
    mission2StepPrepareApproval({
      operationId: "m2-ttl",
      env,
      storeDir,
      ttlMs: 1,
    });
    await new Promise((r) => setTimeout(r, 5));
    const { validateMission2CanaryApproval } = await import(
      "./mission2ExecutionPath.mjs"
    );
    const v = validateMission2CanaryApproval("m2-ttl", {
      env,
      storeDir,
      nowMs: Date.now() + 1000,
    });
    assert.equal(v.ok, false);
    assert.equal(v.reason, "approval_expired");
  });

  it("operator confirm required before propose", async () => {
    await prep("m2-noconfirm");
    await toUnpaused("m2-noconfirm");
    const r = await mission2StepPropose({
      operationId: "m2-noconfirm",
      env,
      storeDir,
      invoke: true,
      testHarness: true,
      deps: {
        paused: false,
        proposeFn: async () => ({ ok: true }),
        pendingVerify: { ok: true, pending: { payload_commitment: "x" } },
      },
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /operator_confirm_required/);
  });

  it("verifyMission2SignedRaw requires recoverFn and amount in auth", () => {
    const r = verifyMission2SignedRaw(FAKE_RAW, {
      deposit_address: "0xdeposit00000000000000000000000000000001",
      amount: TRADE_AMOUNT,
      nonce: 0,
      gas_price: "1",
      gas_limit: "1",
      digest_hex: "ab",
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "recover_fn_required");
  });

  it("dry rehearsal never mutates and reports runner ready", async () => {
    const r = await runMission2DryRehearsal({
      operationId: "m2-dry-unit",
      env,
      storeDir,
      testHarness: true,
      deps: quoteDeps("0xdeposit00000000000000000000000000000001"),
    });
    assert.equal(r.mutations_invoked, false);
    assert.equal(r.hard_stop, true);
    assert.equal(r.runner.ok, true);
    assert.equal(r.ok, true, JSON.stringify(r));
  });
});

describe("Mission2 Base isolation (not Eth / Arb)", () => {
  it("runner capabilities never advertise Arb or Eth source constants", () => {
    const c = mission2RunnerCapabilities();
    assert.equal(c.chain_id, 8453);
    assert.ok(!String(c.asset_in).includes("arb-0x"));
    assert.ok(!String(c.asset_in).includes("eth-0xa0b869"));
    assert.ok(String(c.asset_in).includes("base-0x833589"));
    assert.equal(c.rejects_j8b_operator, true);
    assert.equal(c.rejects_eth_operator, true);
  });

  it("assertMission2Bindings rejects Eth and Arb chain payloads", () => {
    const base = {
      chain_id: 8453,
      token: MISSION2_TOKEN,
      asset_in: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      asset_out:
        "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      amount: TRADE_AMOUNT,
    };
    assert.doesNotThrow(() => assertMission2Bindings(base));
    assert.throws(() => assertMission2Bindings({ ...base, chain_id: 1 }), /eth_chain/);
    assert.throws(() => assertMission2Bindings({ ...base, chain_id: 42161 }), /arb_chain/);
    assert.throws(
      () =>
        assertMission2Bindings({
          ...base,
          token: MAINNET_USDC.ethereum.toLowerCase(),
        }),
      /eth_token/
    );
    assert.throws(
      () => assertMission2Bindings({ ...base, token: CANARY_TOKEN }),
      /j8b_token/
    );
  });
});
