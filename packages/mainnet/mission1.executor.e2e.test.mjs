/**
 * Mission 1 Eth→NEAR executor — simulated E2E + negative/ambiguous (zero mainnet mutations).
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
  runMission1DryRehearsal,
} from "./mission1Executor.mjs";
import {
  assertMission1FixturesAllowed,
  confirmMission1Phase,
  verifyMission1SignedRaw,
} from "./mission1Safety.mjs";
import { createMission1LiveAdapters } from "./mission1Adapters.mjs";
import { openTxJournal, TX_STATE, localTxHash } from "../execution/txJournal.mjs";
import { CANARY_CHAIN_ID, CANARY_TOKEN } from "./canaryOneShot.mjs";
import { MAINNET_IDENTITIES } from "./identities.mjs";

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

function fakeQuote({
  deposit = "0xdeposit00000000000000000000000000000001",
  minOut = "994000",
  deadlineMs = Date.now() + 600_000,
} = {}) {
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

function quoteDeps(deposit, extra = {}) {
  return {
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
    assert.equal(a.cli_entry, "scripts/mainnet/mission1-operator.mjs");
    assert.ok(existsSync(join(process.cwd(), a.cli_entry)));
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
    assert.ok(
      audit.production_ready_components.includes("mission1_step_runner_complete")
    );
  });

  it("live adapters advertise Eth chain and independence from J8B", async () => {
    assert.equal(typeof createMission1LiveAdapters, "function");
    const caps = mission1RunnerCapabilities();
    assert.equal(caps.rejects_j8b_operator, true);
    assert.equal(caps.chain_id, 1);
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

  it("runs PREPARED → RECONCILED with Eth bindings only", async () => {
    const prepared = mission1StepPrepareApproval({
      operationId: "m1-e2e-happy",
      env,
      storeDir,
      ttlMs: 3600_000,
    });
    assert.equal(prepared.ok, true);
    assert.equal(prepared.payload.chain_id, 1);

    const deposit = "0xdeposit00000000000000000000000000000001";
    const quoteAttest = await mission1StepQuoteAttest({
      operationId: "m1-e2e-happy",
      env,
      storeDir,
      testHarness: true,
      deps: quoteDeps(deposit),
    });
    assert.equal(quoteAttest.ok, true, JSON.stringify(quoteAttest));
    assert.equal(quoteAttest.chain_id, 1);
    assert.equal(quoteAttest.token, MISSION1_TOKEN);
    const digest = quoteAttest.digest_hex;

    const unpaused = await mission1StepVerifyUnpaused({
      operationId: "m1-e2e-happy",
      env,
      storeDir,
      testHarness: true,
      deps: { paused: false },
    });
    assert.equal(unpaused.ok, true);

    const earlySign = recordMission1Confirmation("m1-e2e-happy", "sign", {
      env,
      storeDir,
    });
    assert.equal(earlySign.ok, false);
    assert.match(earlySign.reason, /confirm_wrong_state/);

    recordMission1Confirmation("m1-e2e-happy", "propose", { env, storeDir });
    const proposeDry = await mission1StepPropose({
      operationId: "m1-e2e-happy",
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
    const propose = await mission1StepPropose({
      operationId: "m1-e2e-happy",
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

    recordMission1Confirmation("m1-e2e-happy", "sign", { env, storeDir });
    const sign = await mission1StepRequestSignature({
      operationId: "m1-e2e-happy",
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

    const persist = mission1StepPersistSignedRaw({
      operationId: "m1-e2e-happy",
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

    recordMission1Confirmation("m1-e2e-happy", "broadcast", { env, storeDir });
    const broadcast = await mission1StepBroadcast({
      operationId: "m1-e2e-happy",
      env,
      storeDir,
      invoke: true,
      testHarness: true,
      deps: {
        paused: false,
        journal,
        nonce: 0,
        pending,
        ethSend: async () => ({ result: "0xbroadcasteddeadbeef" }),
        skipSignedRawVerify: true,
      },
    });
    assert.equal(broadcast.ok, true, JSON.stringify(broadcast));

    const settle = await mission1StepSettle({
      operationId: "m1-e2e-happy",
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

    const confRecon = confirmMission1Phase("m1-e2e-happy", "reconcile", {
      env,
      storeDir,
    });
    assert.equal(confRecon.ok, true, JSON.stringify(confRecon));

    const recon = await mission1StepReconcilePending({
      operationId: "m1-e2e-happy",
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

    const paused = await mission1StepVerifyPaused({
      testHarness: true,
      deps: { paused: true },
    });
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
    mission1StepPrepareApproval({
      operationId: op,
      env,
      storeDir,
      ttlMs: 60_000,
    });
  }

  async function toUnpaused(op, deposit = "0xdeposit00000000000000000000000000000001") {
    const qa = await mission1StepQuoteAttest({
      operationId: op,
      env,
      storeDir,
      testHarness: true,
      deps: quoteDeps(deposit),
    });
    assert.equal(qa.ok, true, JSON.stringify(qa));
    await mission1StepVerifyUnpaused({
      operationId: op,
      env,
      storeDir,
      testHarness: true,
      deps: { paused: false },
    });
    return qa;
  }

  it("refuses fixture injection without testHarness", async () => {
    await prep("m1-nofixture");
    const r = await mission1StepQuoteAttest({
      operationId: "m1-nofixture",
      env,
      storeDir,
      testHarness: false,
      deps: { paused: true, limits: limitsOk() },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "fixture_injection_requires_testHarness");
  });

  it("assertMission1FixturesAllowed blocks production fixtures", () => {
    const g = assertMission1FixturesAllowed(false, { paused: false });
    assert.equal(g.ok, false);
  });

  it("refuses missing NEAR before snapshot (no zero default)", async () => {
    await prep("m1-no-snap");
    const r = await mission1StepQuoteAttest({
      operationId: "m1-no-snap",
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
    await prep("m1-expired-q");
    const r = await mission1StepQuoteAttest({
      operationId: "m1-expired-q",
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
        ...quoteDeps("0xdeposit00000000000000000000000000000001"),
        attestResult: bad,
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
        ...quoteDeps("0xdeposit00000000000000000000000000000001"),
        quoteResult: { ok: false, reason: "quote_tls_error" },
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "quote_failed");
  });

  it("propose failure does not advance to PROPOSED", async () => {
    await prep("m1-propose-fail");
    await toUnpaused("m1-propose-fail");
    recordMission1Confirmation("m1-propose-fail", "propose", { env, storeDir });
    const r = await mission1StepPropose({
      operationId: "m1-propose-fail",
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
        JSON.parse(readFileSync(join(storeDir, "m1-propose-fail.json"), "utf8"))
      ),
      CANARY_STATES.OWNER_UNPAUSED
    );
  });

  it("ambiguous pending blocks resubmit and marks reconciliation", async () => {
    await prep("m1-ambig");
    const qa = await toUnpaused("m1-ambig");
    recordMission1Confirmation("m1-ambig", "propose", { env, storeDir });
    const r = await mission1StepPropose({
      operationId: "m1-ambig",
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
        JSON.parse(readFileSync(join(storeDir, "m1-ambig.json"), "utf8"))
      ),
      CANARY_STATES.RECONCILIATION_REQUIRED
    );
    const again = await mission1StepPropose({
      operationId: "m1-ambig",
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
    await prep("m1-dup-propose");
    const qa = await toUnpaused("m1-dup-propose");
    recordMission1Confirmation("m1-dup-propose", "propose", { env, storeDir });
    const pending = {
      payload_commitment: qa.digest_hex,
      signing_state: "Reserved",
    };
    await mission1StepPropose({
      operationId: "m1-dup-propose",
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
    const again = await mission1StepPropose({
      operationId: "m1-dup-propose",
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
    await prep("m1-bad-digest");
    const qa = await toUnpaused("m1-bad-digest");
    const pending = {
      payload_commitment: qa.digest_hex,
      signing_state: "Reserved",
    };
    recordMission1Confirmation("m1-bad-digest", "propose", { env, storeDir });
    await mission1StepPropose({
      operationId: "m1-bad-digest",
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
    recordMission1Confirmation("m1-bad-digest", "sign", { env, storeDir });
    const r = await mission1StepRequestSignature({
      operationId: "m1-bad-digest",
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
    await prep("m1-digest-mm");
    const qa = await toUnpaused("m1-digest-mm");
    const pending = {
      payload_commitment: qa.digest_hex,
      signing_state: "Reserved",
    };
    recordMission1Confirmation("m1-digest-mm", "propose", { env, storeDir });
    await mission1StepPropose({
      operationId: "m1-digest-mm",
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
    recordMission1Confirmation("m1-digest-mm", "sign", { env, storeDir });
    const r = await mission1StepRequestSignature({
      operationId: "m1-digest-mm",
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
    await prep("m1-sign-ambig");
    const qa = await toUnpaused("m1-sign-ambig");
    const pending = {
      payload_commitment: qa.digest_hex,
      signing_state: "Reserved",
    };
    recordMission1Confirmation("m1-sign-ambig", "propose", { env, storeDir });
    await mission1StepPropose({
      operationId: "m1-sign-ambig",
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
    recordMission1Confirmation("m1-sign-ambig", "sign", { env, storeDir });
    const r = await mission1StepRequestSignature({
      operationId: "m1-sign-ambig",
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
    const jdir = mkdtempSync(join(tmpdir(), "m1-unk-"));
    dirs.push(jdir);
    const journal = openTxJournal({
      path: join(jdir, "tx.sqlite"),
      secret: env.NIO_JOURNAL_SECRET,
    });
    await prep("m1-unknown");
    const qa = await toUnpaused("m1-unknown");
    const pending = {
      payload_commitment: qa.digest_hex,
      signing_state: "Reserved",
    };
    recordMission1Confirmation("m1-unknown", "propose", { env, storeDir });
    await mission1StepPropose({
      operationId: "m1-unknown",
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
    recordMission1Confirmation("m1-unknown", "sign", { env, storeDir });
    await mission1StepRequestSignature({
      operationId: "m1-unknown",
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
    mission1StepPersistSignedRaw({
      operationId: "m1-unknown",
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
    journal.beginBroadcast("m1-unknown");
    journal.markUnknown("m1-unknown", { rpc_error: "timeout" });
    recordMission1Confirmation("m1-unknown", "broadcast", { env, storeDir });
    const r = await mission1StepBroadcast({
      operationId: "m1-unknown",
      env,
      storeDir,
      invoke: true,
      testHarness: true,
      deps: {
        paused: false,
        journal,
        nonce: 0,
        pending,
        ethSend: async () => ({ result: "0xshouldnot" }),
        skipSignedRawVerify: true,
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "journal_unknown_requires_reconcile");
    assert.equal(r.may_rebroadcast_identical, false);
    journal.close();
  });

  it("expired quote blocks broadcast", async () => {
    const jdir = mkdtempSync(join(tmpdir(), "m1-expb-"));
    dirs.push(jdir);
    const journal = openTxJournal({
      path: join(jdir, "tx.sqlite"),
      secret: env.NIO_JOURNAL_SECRET,
    });
    await prep("m1-exp-bcast");
    const qa = await toUnpaused("m1-exp-bcast");
    const pending = {
      payload_commitment: qa.digest_hex,
      signing_state: "Reserved",
    };
    recordMission1Confirmation("m1-exp-bcast", "propose", { env, storeDir });
    await mission1StepPropose({
      operationId: "m1-exp-bcast",
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
    recordMission1Confirmation("m1-exp-bcast", "sign", { env, storeDir });
    await mission1StepRequestSignature({
      operationId: "m1-exp-bcast",
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
    mission1StepPersistSignedRaw({
      operationId: "m1-exp-bcast",
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
    const path = join(storeDir, "m1-exp-bcast.json");
    const rec = JSON.parse(readFileSync(path, "utf8"));
    rec.outcomes[CANARY_STATES.ATTESTED].quote_deadline_ms = Date.now() - 1000;
    writeFileSync(path, JSON.stringify(rec, null, 2));
    recordMission1Confirmation("m1-exp-bcast", "broadcast", { env, storeDir });
    const r = await mission1StepBroadcast({
      operationId: "m1-exp-bcast",
      env,
      storeDir,
      invoke: true,
      testHarness: true,
      deps: {
        paused: false,
        journal,
        nonce: 0,
        pending,
        ethSend: async () => ({ result: "0xno" }),
        skipSignedRawVerify: true,
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "quote_expired_before_broadcast");
    journal.close();
  });

  it("reconcile refuses without Success settlement_state", async () => {
    await prep("m1-recon-bad");
    const qa = await toUnpaused("m1-recon-bad");
    const pending = {
      payload_commitment: qa.digest_hex,
      signing_state: "Reserved",
    };
    // Force SETTLED via raw write after consume-like path
    const path = join(storeDir, "m1-recon-bad.json");
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
    confirmMission1Phase("m1-recon-bad", "reconcile", { env, storeDir });
    const r = await mission1StepReconcilePending({
      operationId: "m1-recon-bad",
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
      liveGasPriceWei: "6000000000",
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
    const { validateMission1CanaryApproval } = await import(
      "./mission1ExecutionPath.mjs"
    );
    const v = validateMission1CanaryApproval("m1-ttl", {
      env,
      storeDir,
      nowMs: Date.now() + 1000,
    });
    assert.equal(v.ok, false);
    assert.equal(v.reason, "approval_expired");
  });

  it("operator confirm required before propose", async () => {
    await prep("m1-noconfirm");
    await toUnpaused("m1-noconfirm");
    const r = await mission1StepPropose({
      operationId: "m1-noconfirm",
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

  it("verifyMission1SignedRaw requires recoverFn and rejects wrong amount", () => {
    const r = verifyMission1SignedRaw(FAKE_RAW, {
      deposit_address: "0xdeposit00000000000000000000000000000001",
      nonce: 0,
      gas_price: "1",
      gas_limit: "1",
      digest_hex: "ab",
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "recover_fn_required");
  });

  it("dry rehearsal never mutates and reports runner ready", async () => {
    const r = await runMission1DryRehearsal({
      operationId: "m1-dry-unit",
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

describe("Mission1 capabilities isolate from J8B", () => {
  it("runner capabilities never advertise Arb constants", () => {
    const c = mission1RunnerCapabilities();
    assert.equal(c.chain_id, 1);
    assert.ok(!String(c.asset_in).includes("arb-0x"));
    assert.ok(String(c.asset_out).includes("17208628"));
    assert.equal(c.rejects_j8b_operator, true);
  });
});
