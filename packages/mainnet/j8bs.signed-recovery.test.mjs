/**
 * J8B-S — extract MPC sig from real RPC shapes + signed-tx recovery (zero mutations).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractMpcSigFromNearTx } from "../gate-k/settle.mjs";
import {
  createCanaryApproval,
  loadCanaryApproval,
  loadRecoveryAuthorization,
  loadSignedTxRecoveryAuthorization,
  validateExecutableApproval,
  signApprovalPayload,
  CANARY_STATES,
  CANARY_AMOUNT,
  SIGNED_TX_RECOVERY_KIND,
  RECOVERY_KIND,
} from "./canaryOneShot.mjs";
import {
  assembleAndVerifySignedCanaryTx,
  inspectSignedRecovery,
  createSignedTxRecoveryAuthorization,
  persistSignedRawCanary,
} from "./canarySignedRecovery.mjs";
import { canaryStepRequestSignature } from "./canaryExecutor.mjs";
import { localTxHash, openTxJournal } from "../execution/txJournal.mjs";
import { MAINNET_IDENTITIES } from "./identities.mjs";

const STORE = mkdtempSync(join(tmpdir(), "nio-j8bs-"));
const ENV = {
  NIO_CANARY_HMAC_SECRET: "j8bs-secret-key-32bytes-minimum!!",
  NIO_JOURNAL_SECRET: "j8bs-journal-secret-key-32bytes-min!",
};
const ESCROW = "0xcaa3dc3d6d2bb72ade403c614949e66d5ed37f1e";
const DIGEST =
  "b1811f74b1c61a67a9f0d80dfabbdd14e46904d5585f847b80c49801ea0640ed";
const SIGN_TX = "27VQYinCZFddL6aXzyajktex6dbEJsjjVdUVD5KjsPVp";
const MPC = MAINNET_IDENTITIES.mpc_evm_address.toLowerCase();

after(() => {
  try {
    rmSync(STORE, { recursive: true, force: true });
  } catch {
    /* */
  }
});

function mpcSv(sig) {
  return Buffer.from(JSON.stringify(sig)).toString("base64");
}

function sampleSig(overrides = {}) {
  return {
    scheme: "Secp256k1",
    big_r: {
      affine_point:
        "0325b83eb3cab603ed3af297db84902cdaccec8958d884d37b3626836e4a435b18",
    },
    s: {
      scalar:
        "65ee9ec93acd98cfe1f8ef9ee61acc2d87fb74a0bbe482663774eb0f60dd3ad3",
    },
    recovery_id: 1,
    ...overrides,
  };
}

function txWithReceipts(successValues, { wrap = false, logs = [] } = {}) {
  const receipts_outcome = successValues.map((sv, i) => ({
    outcome: {
      executor_id: i === 0 ? "v1.signer" : "policy.nishanthb.near",
      status: sv != null ? { SuccessValue: sv } : { SuccessValue: "" },
      logs: i === 1 ? logs : [],
    },
  }));
  const body = {
    transaction: {
      signer_id: MAINNET_IDENTITIES.agent,
      receiver_id: MAINNET_IDENTITIES.policy,
    },
    status: { SuccessValue: successValues.find(Boolean) || "" },
    transaction_outcome: { outcome: { status: { SuccessValue: "" }, logs: [] } },
    receipts_outcome,
  };
  return wrap ? { result: body } : body;
}

function seedFailedOriginal(op) {
  createCanaryApproval({
    operationId: op,
    storeDir: STORE,
    env: ENV,
    quoteHash: "Gs9eGyUUEJRDX41coUercha13ooBpfuUK3gdfKQTXkgG",
    depositAddress: ESCROW,
  });
  const loaded = loadCanaryApproval(op, { storeDir: STORE, env: ENV });
  loaded.record.used = true;
  loaded.record.lifecycle_state = CANARY_STATES.FAILED;
  loaded.record.consume_reason = "payload_commitment_mismatch";
  loaded.record.locked_digest_hex = DIGEST;
  loaded.record.locked_nonce = 0;
  loaded.record.locked_gas_price = "30000000";
  loaded.record.locked_gas_limit = "100000";
  loaded.record.base_usdc_before = "0";
  loaded.record.locked_local_tx_hash = null;
  loaded.record.locked_broadcast_hash = null;
  loaded.record.outcomes = {
    QUOTE_VERIFIED: {
      min_out: "994904",
      quote_deadline_ms: Date.now() + 3_600_000,
      quote_hash: loaded.record.payload.quote_hash,
      deposit: ESCROW,
    },
  };
  writeFileSync(loaded.path, JSON.stringify(loaded.record, null, 2));
  return loaded;
}

function seedFailedRecovery(op, original) {
  const expires_at = new Date(Date.now() + 60_000).toISOString();
  const payload = {
    ...original.record.payload,
    expires_at,
    kind: RECOVERY_KIND,
    recovery_of_fingerprint: original.record.fingerprint,
    near_propose_tx: "HnpL7Sh2E7QPSi4rq1sefDQV4nYayFnKpkvbU2NUdzad",
    forbids_propose: true,
    digest_hex: DIGEST,
    quote_deadline_ms: Date.now() + 3_600_000,
    min_amount_out: "994904",
    recipient: MPC,
    refund_to: MPC,
    base_usdc_before: "0",
    locked_nonce: 0,
    locked_gas_price: "30000000",
    locked_gas_limit: "100000",
  };
  const { mac, fingerprint } = signApprovalPayload(payload, ENV);
  const record = {
    version: 2,
    created_at: new Date().toISOString(),
    payload,
    mac,
    fingerprint,
    used: false,
    lifecycle_state: CANARY_STATES.FAILED,
    locked_digest_hex: DIGEST,
    locked_local_tx_hash: null,
    locked_broadcast_hash: null,
    outcomes: {
      QUOTE_VERIFIED: {
        min_out: "994904",
        quote_deadline_ms: Date.now() + 3_600_000,
      },
      FAILED: { at: new Date().toISOString(), reason: "MPC_SIG_NOT_FOUND" },
    },
  };
  const path = join(STORE, `recovery-${op}.json`);
  writeFileSync(path, JSON.stringify(record, null, 2));
  return { record, path, macBefore: mac };
}

const SAMPLE_RAW = "0x" + "ab".repeat(120);
const SAMPLE_LOCAL_HASH = localTxHash(SAMPLE_RAW);
const CONFLICT_RAW = "0x" + "cd".repeat(120);

const goodAssembled = {
  ok: true,
  digest_hex: DIGEST,
  recovered: MPC,
  local_tx_hash: SAMPLE_LOCAL_HASH,
  rawHex: SAMPLE_RAW,
  candidate_count: 2,
  unique_count: 1,
  tx_fields: {
    chain_id: 42161,
    nonce: 0,
    token: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    escrow: ESCROW,
    amount: CANARY_AMOUNT,
    gas_price: "30000000",
    gas_limit: "100000",
    operation_id: null,
  },
};

function signedPending(opOverrides = {}) {
  return {
    epoch: 2,
    signing_state: "Signed",
    settlement_state: "None",
    payload_commitment: DIGEST,
    destination: ESCROW,
    amount_in: CANARY_AMOUNT,
    ...opOverrides,
  };
}

function viewAdapters(pending = signedPending()) {
  return {
    getPaused: async () => true,
    getMandateEpoch: async () => 2,
    getPending: async () => pending,
  };
}

async function createSignedAuth(op, extraDeps = {}) {
  const original = seedFailedOriginal(op);
  seedFailedRecovery(op, original);
  const created = await createSignedTxRecoveryAuthorization({
    operationId: op,
    nearSignTx: SIGN_TX,
    nearProposeTx: "HnpL7Sh2E7QPSi4rq1sefDQV4nYayFnKpkvbU2NUdzad",
    storeDir: STORE,
    env: ENV,
    testHarness: true,
    operatorConfirmed: true,
    deps: {
      pending: signedPending(),
      nearTx: txWithReceipts([mpcSv(sampleSig()), mpcSv(sampleSig())], {
        logs: [
          `EVENT_JSON:${JSON.stringify({ event: "signed", operation_id: op })}`,
        ],
      }),
      assembled: goodAssembled,
      arbNonce: {
        ok: true,
        mpc_nonce: 0,
        expected_nonce: 0,
        nonce_available_for_broadcast: true,
      },
      proposeReceiptVerify: { ok: true, independently_verified: true },
      adapters: viewAdapters(),
      ...extraDeps,
    },
  });
  assert.equal(created.ok, true);
  return created;
}

describe("J8B-S extractMpcSigFromNearTx", () => {
  it("finds identical signatures on unwrapped top-level receipts_outcome", () => {
    const sig = sampleSig();
    const tx = txWithReceipts([mpcSv(sig), mpcSv(sig)], { wrap: false });
    const r = extractMpcSigFromNearTx(tx);
    assert.equal(r.found, true);
    assert.equal(r.candidate_count, 2);
    assert.equal(r.unique_count, 1);
    assert.equal(r.signature_json.recovery_id, 1);
  });

  it("finds signatures on wrapped result.receipts_outcome", () => {
    const sig = sampleSig();
    const tx = txWithReceipts([mpcSv(sig)], { wrap: true });
    const r = extractMpcSigFromNearTx(tx);
    assert.equal(r.found, true);
    assert.equal(r.candidate_count, 1);
  });

  it("NO-GO on conflicting candidate signatures", () => {
    const a = sampleSig();
    const b = sampleSig({
      s: { scalar: "11".repeat(32) },
    });
    const r = extractMpcSigFromNearTx(
      txWithReceipts([mpcSv(a), mpcSv(b)], { wrap: false })
    );
    assert.equal(r.found, false);
    assert.equal(r.reason, "MPC_SIG_CONFLICTING");
    assert.equal(r.unique_count, 2);
  });

  it("NO-GO on malformed MPC-shaped SuccessValue", () => {
    const bad = Buffer.from(
      JSON.stringify({ scheme: "Secp256k1", big_r: { affine_point: "0x" } })
    ).toString("base64");
    const r = extractMpcSigFromNearTx(txWithReceipts([bad]));
    assert.equal(r.found, false);
    assert.equal(r.reason, "MPC_SIG_MALFORMED");
  });

  it("NO-GO when no MPC SuccessValue present", () => {
    const r = extractMpcSigFromNearTx(
      txWithReceipts([Buffer.from("ok").toString("base64")])
    );
    assert.equal(r.found, false);
    assert.equal(r.reason, "MPC_SIG_NOT_FOUND");
  });
});

describe("J8B-S assembleAndVerifySignedCanaryTx", () => {
  it("rejects digest mismatch without returning success", () => {
    const sig = sampleSig();
    const tx = txWithReceipts([mpcSv(sig), mpcSv(sig)]);
    const r = assembleAndVerifySignedCanaryTx({
      nearTxFull: tx,
      operationId: "op-x",
      digestHexExpected: "ff".repeat(32),
      depositAddress: ESCROW,
      nonce: 0,
      gasPrice: "30000000",
      gasLimit: "100000",
    });
    assert.equal(r.ok, false);
    assert.ok(
      r.reason === "digest_recalc_mismatch" ||
        r.reason === "recovered_address_mismatch"
    );
  });
});

describe("J8B-S inspect + signed recovery auth", () => {
  it("inspect marks SAFE for already-Signed with verified evidence", async () => {
    const op = "op-j8bs-safe";
    seedFailedOriginal(op);
    seedFailedRecovery(op, loadCanaryApproval(op, { storeDir: STORE, env: ENV }));
    const sig = sampleSig();
    const nearTx = txWithReceipts([mpcSv(sig), mpcSv(sig)], {
      logs: [
        `EVENT_JSON:${JSON.stringify({ event: "signed", operation_id: op })}`,
      ],
    });
    const insp = await inspectSignedRecovery({
      operationId: op,
      nearSignTx: SIGN_TX,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      deps: {
        pending: {
          epoch: 2,
          signing_state: "Signed",
          settlement_state: "None",
          payload_commitment: DIGEST,
          destination: ESCROW,
          amount_in: CANARY_AMOUNT,
        },
        nearTx,
        assembled: { ...goodAssembled, tx_fields: { ...goodAssembled.tx_fields, operation_id: op } },
        arbNonce: {
          ok: true,
          mpc_nonce: 0,
          expected_nonce: 0,
          nonce_available_for_broadcast: true,
          possible_prior_broadcast: false,
        },
        adapters: {
          getPaused: async () => true,
          getMandateEpoch: async () => 2,
          getPending: async () => ({
            epoch: 2,
            signing_state: "Signed",
            settlement_state: "None",
            payload_commitment: DIGEST,
          }),
        },
      },
    });
    assert.equal(insp.verdict, "SAFE_TO_CREATE_SIGNED_TX_RECOVERY_AUTH");
    assert.equal(insp.mutations_invoked, false);
    assert.equal(insp.assembled.ok, true);
    assert.equal(insp.assembled.recovered, MPC);
    assert.equal(insp.assembled.rawHex, undefined);
    assert.equal(insp.assembled.signature_json, undefined);
  });

  it("NO-GO on incorrect recovered signer", async () => {
    const op = "op-j8bs-badsig";
    seedFailedOriginal(op);
    const insp = await inspectSignedRecovery({
      operationId: op,
      nearSignTx: SIGN_TX,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      deps: {
        pending: {
          epoch: 2,
          signing_state: "Signed",
          settlement_state: "None",
          payload_commitment: DIGEST,
        },
        nearTx: txWithReceipts([mpcSv(sampleSig())]),
        assembled: {
          ok: false,
          reason: "recovered_address_mismatch",
          recovered: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        },
        arbNonce: {
          ok: true,
          mpc_nonce: 0,
          expected_nonce: 0,
          nonce_available_for_broadcast: true,
        },
        adapters: {
          getPaused: async () => true,
          getMandateEpoch: async () => 2,
          getPending: async () => ({
            epoch: 2,
            signing_state: "Signed",
            settlement_state: "None",
            payload_commitment: DIGEST,
          }),
        },
      },
    });
    assert.equal(insp.verdict, "NO-GO");
    assert.equal(insp.checks.recovered_mpc_match, false);
  });

  it("creates signed recovery without mutating FAILED records; forbids request_signature", async () => {
    const op = "op-j8bs-create";
    const original = seedFailedOriginal(op);
    const prior = seedFailedRecovery(op, original);
    const macOrig = original.record.mac;
    const created = await createSignedTxRecoveryAuthorization({
      operationId: op,
      nearSignTx: SIGN_TX,
      nearProposeTx: "HnpL7Sh2E7QPSi4rq1sefDQV4nYayFnKpkvbU2NUdzad",
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      operatorConfirmed: true,
      deps: {
        pending: {
          epoch: 2,
          signing_state: "Signed",
          settlement_state: "None",
          payload_commitment: DIGEST,
          destination: ESCROW,
        },
        nearTx: txWithReceipts([mpcSv(sampleSig()), mpcSv(sampleSig())], {
          logs: [
            `EVENT_JSON:${JSON.stringify({ event: "signed", operation_id: op })}`,
          ],
        }),
        assembled: goodAssembled,
        arbNonce: {
          ok: true,
          mpc_nonce: 0,
          expected_nonce: 0,
          nonce_available_for_broadcast: true,
        },
        proposeReceiptVerify: { ok: true, independently_verified: true },
        adapters: {
          getPaused: async () => true,
          getMandateEpoch: async () => 2,
          getPending: async () => ({
            epoch: 2,
            signing_state: "Signed",
            settlement_state: "None",
            payload_commitment: DIGEST,
          }),
        },
      },
    });
    assert.equal(created.ok, true);
    assert.equal(created.forbids_request_signature, true);
    assert.equal(created.raw_persisted, false);
    assert.equal(created.lifecycle_state, CANARY_STATES.MPC_SIGNED);

    const origAfter = loadCanaryApproval(op, { storeDir: STORE, env: ENV });
    assert.equal(origAfter.record.mac, macOrig);
    assert.equal(origAfter.record.lifecycle_state, CANARY_STATES.FAILED);
    const priorAfter = loadRecoveryAuthorization(op, {
      storeDir: STORE,
      env: ENV,
    });
    assert.equal(priorAfter.record.mac, prior.macBefore);
    assert.equal(priorAfter.record.lifecycle_state, CANARY_STATES.FAILED);

    const signed = loadSignedTxRecoveryAuthorization(op, {
      storeDir: STORE,
      env: ENV,
    });
    assert.equal(signed.ok, true);
    assert.equal(signed.record.payload.kind, SIGNED_TX_RECOVERY_KIND);
    assert.equal(signed.record.payload.forbids_request_signature, true);

    const v = validateExecutableApproval(op, {
      storeDir: STORE,
      env: ENV,
      requireQuoteBound: true,
    });
    assert.equal(v.ok, true);
    assert.equal(v.is_signed_recovery, true);

    const signAttempt = await canaryStepRequestSignature({
      operationId: op,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      invoke: true,
      deps: {
        adapters: {
          requestSignature: async () => {
            throw new Error("must_not_request_signature");
          },
        },
      },
    });
    assert.equal(signAttempt.ok, false);
    assert.equal(
      signAttempt.reason,
      "request_signature_forbidden_on_signed_recovery"
    );
  });

  it("refuses create without operatorConfirmed; expired prior recovery remains untouched", async () => {
    const op = "op-j8bs-expired-prior";
    const original = seedFailedOriginal(op);
    const prior = seedFailedRecovery(op, original);
    // Expire prior recovery auth (must not be extended/bypassed)
    const payload = {
      ...prior.record.payload,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    };
    const { mac, fingerprint } = signApprovalPayload(payload, ENV);
    writeFileSync(
      prior.path,
      JSON.stringify({ ...prior.record, payload, mac, fingerprint }, null, 2)
    );

    const denied = await createSignedTxRecoveryAuthorization({
      operationId: op,
      nearSignTx: SIGN_TX,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      operatorConfirmed: false,
    });
    assert.equal(denied.ok, false);

    const created = await createSignedTxRecoveryAuthorization({
      operationId: op,
      nearSignTx: SIGN_TX,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      operatorConfirmed: true,
      deps: {
        pending: {
          epoch: 2,
          signing_state: "Signed",
          settlement_state: "None",
          payload_commitment: DIGEST,
          destination: ESCROW,
        },
        nearTx: txWithReceipts([mpcSv(sampleSig()), mpcSv(sampleSig())], {
          logs: [
            `EVENT_JSON:${JSON.stringify({ event: "signed", operation_id: op })}`,
          ],
        }),
        assembled: goodAssembled,
        arbNonce: {
          ok: true,
          mpc_nonce: 0,
          expected_nonce: 0,
          nonce_available_for_broadcast: true,
        },
        adapters: {
          getPaused: async () => true,
          getMandateEpoch: async () => 2,
          getPending: async () => ({
            epoch: 2,
            signing_state: "Signed",
            settlement_state: "None",
            payload_commitment: DIGEST,
          }),
        },
      },
    });
    assert.equal(created.ok, true);
    const priorAfter = JSON.parse(readFileSync(prior.path, "utf8"));
    assert.ok(Date.parse(priorAfter.payload.expires_at) < Date.now());
    assert.equal(priorAfter.lifecycle_state, CANARY_STATES.FAILED);
  });

  it("NO-GO inspect when signing_state is not Signed", async () => {
    const op = "op-j8bs-not-signed";
    seedFailedOriginal(op);
    const insp = await inspectSignedRecovery({
      operationId: op,
      nearSignTx: SIGN_TX,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      deps: {
        pending: {
          epoch: 2,
          signing_state: "Reserved",
          settlement_state: "None",
          payload_commitment: DIGEST,
        },
        nearTx: txWithReceipts([mpcSv(sampleSig())]),
        assembled: goodAssembled,
        arbNonce: {
          ok: true,
          mpc_nonce: 0,
          expected_nonce: 0,
          nonce_available_for_broadcast: true,
        },
        adapters: {
          getPaused: async () => true,
          getMandateEpoch: async () => 2,
          getPending: async () => ({
            signing_state: "Reserved",
            settlement_state: "None",
            payload_commitment: DIGEST,
            epoch: 2,
          }),
        },
      },
    });
    assert.equal(insp.verdict, "NO-GO");
    assert.equal(insp.checks.signing_signed, false);
  });

  it("NO-GO when only one of mandate/pending epochs matches", async () => {
    const op = "op-j8bs-epoch-or";
    seedFailedOriginal(op);
    const insp = await inspectSignedRecovery({
      operationId: op,
      nearSignTx: SIGN_TX,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      deps: {
        pending: signedPending({ epoch: 3 }),
        nearTx: txWithReceipts([mpcSv(sampleSig()), mpcSv(sampleSig())], {
          logs: [
            `EVENT_JSON:${JSON.stringify({ event: "signed", operation_id: op })}`,
          ],
        }),
        assembled: goodAssembled,
        arbNonce: {
          ok: true,
          mpc_nonce: 0,
          expected_nonce: 0,
          nonce_available_for_broadcast: true,
        },
        adapters: {
          getPaused: async () => true,
          getMandateEpoch: async () => 2,
          getPending: async () => signedPending({ epoch: 3 }),
        },
      },
    });
    assert.equal(insp.verdict, "NO-GO");
    assert.equal(insp.checks.epoch_mandate_match, true);
    assert.equal(insp.checks.epoch_pending_match, false);
    assert.equal(insp.checks.epoch_match, false);
  });

  it("NO-GO when proposal hash supplied but receipt not verified", async () => {
    const op = "op-j8bs-propose-miss";
    seedFailedOriginal(op);
    const insp = await inspectSignedRecovery({
      operationId: op,
      nearSignTx: SIGN_TX,
      nearProposeTx: "HnpL7Sh2E7QPSi4rq1sefDQV4nYayFnKpkvbU2NUdzad",
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      deps: {
        pending: signedPending(),
        nearTx: txWithReceipts([mpcSv(sampleSig()), mpcSv(sampleSig())], {
          logs: [
            `EVENT_JSON:${JSON.stringify({ event: "signed", operation_id: op })}`,
          ],
        }),
        assembled: goodAssembled,
        proposeReceiptVerify: { ok: false, reason: "quoted_evm_reserved_not_found_in_receipt" },
        arbNonce: {
          ok: true,
          mpc_nonce: 0,
          expected_nonce: 0,
          nonce_available_for_broadcast: true,
        },
        adapters: viewAdapters(),
      },
    });
    assert.equal(insp.verdict, "NO-GO");
    assert.equal(insp.checks.propose_receipt_ok, false);
  });
});

describe("J8B-S persist-signed-raw", () => {
  it("dry-run recovers bindings without journal mutation", async () => {
    const op = "op-j8bs-persist-dry";
    await createSignedAuth(op);
    const dry = await persistSignedRawCanary({
      operationId: op,
      nearSignTx: SIGN_TX,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      invoke: false,
      deps: {
        pending: signedPending(),
        nearTx: txWithReceipts([mpcSv(sampleSig())]),
        assembled: goodAssembled,
        arbNonce: {
          ok: true,
          mpc_nonce: 0,
          expected_nonce: 0,
          nonce_available_for_broadcast: true,
        },
        proposeReceiptVerify: { ok: true },
        adapters: viewAdapters(),
      },
    });
    assert.equal(dry.ok, true);
    assert.equal(dry.dry, true);
    assert.equal(dry.raw_persisted, false);
    assert.equal(dry.mutations_invoked, false);
    assert.equal(dry.local_tx_hash, SAMPLE_LOCAL_HASH);
    const life = loadSignedTxRecoveryAuthorization(op, {
      storeDir: STORE,
      env: ENV,
    });
    assert.equal(life.record.lifecycle_state, CANARY_STATES.MPC_SIGNED);
  });

  it("rejects expired signed-recovery auth", async () => {
    const op = "op-j8bs-persist-exp";
    await createSignedAuth(op);
    const rec = loadSignedTxRecoveryAuthorization(op, {
      storeDir: STORE,
      env: ENV,
    });
    const payload = {
      ...rec.record.payload,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    };
    const { mac, fingerprint } = signApprovalPayload(payload, ENV);
    writeFileSync(
      rec.path,
      JSON.stringify({ ...rec.record, payload, mac, fingerprint }, null, 2)
    );
    const r = await persistSignedRawCanary({
      operationId: op,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      invoke: true,
      operatorConfirmed: true,
      deps: {
        pending: signedPending(),
        assembled: goodAssembled,
        arbNonce: {
          ok: true,
          mpc_nonce: 0,
          expected_nonce: 0,
          nonce_available_for_broadcast: true,
        },
        adapters: viewAdapters(),
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "approval_expired");
  });

  it("persists journal, advances READY_TO_BROADCAST, idempotent on retry", async () => {
    const op = "op-j8bs-persist-ok";
    await createSignedAuth(op);
    const journalPath = join(STORE, `journal-${op}.sqlite`);
    const deps = {
      pending: signedPending(),
      nearTx: txWithReceipts([mpcSv(sampleSig())]),
      assembled: goodAssembled,
      arbNonce: {
        ok: true,
        mpc_nonce: 0,
        expected_nonce: 0,
        nonce_available_for_broadcast: true,
      },
      proposeReceiptVerify: { ok: true },
      adapters: viewAdapters(),
      journalPath,
    };
    const first = await persistSignedRawCanary({
      operationId: op,
      nearSignTx: SIGN_TX,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      invoke: true,
      operatorConfirmed: true,
      deps,
    });
    assert.equal(first.ok, true);
    assert.equal(first.raw_persisted, true);
    assert.equal(first.stage, CANARY_STATES.READY_TO_BROADCAST);
    assert.equal(first.local_tx_hash, SAMPLE_LOCAL_HASH);

    const signed = loadSignedTxRecoveryAuthorization(op, {
      storeDir: STORE,
      env: ENV,
    });
    assert.equal(signed.record.lifecycle_state, CANARY_STATES.READY_TO_BROADCAST);

    // Crash/restart: reopen journal, duplicate persist is idempotent
    const journal = openTxJournal({
      path: journalPath,
      secret: ENV.NIO_JOURNAL_SECRET,
    });
    const raw = journal.loadSignedRaw(op);
    assert.ok(raw);
    assert.equal(localTxHash(raw), SAMPLE_LOCAL_HASH);

    const second = await persistSignedRawCanary({
      operationId: op,
      nearSignTx: SIGN_TX,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      invoke: true,
      operatorConfirmed: true,
      deps: { ...deps, journal },
    });
    assert.equal(second.ok, true);
    assert.equal(second.idempotent, true);
    assert.equal(second.local_tx_hash, SAMPLE_LOCAL_HASH);
  });

  it("NO-GO on conflicting journal bytes", async () => {
    const op = "op-j8bs-persist-conflict";
    await createSignedAuth(op);
    const journalPath = join(STORE, `journal-${op}.sqlite`);
    const journal = openTxJournal({
      path: journalPath,
      secret: ENV.NIO_JOURNAL_SECRET,
    });
    journal.insertDraft({
      id: op,
      portfolio_id: MAINNET_IDENTITIES.portfolio_id,
      idempotency_key: `canary:${op}`,
      nonce: "0",
      chain_id: "42161",
      meta: {},
    });
    journal.markSigned(op, { signedRawHex: CONFLICT_RAW });

    const r = await persistSignedRawCanary({
      operationId: op,
      nearSignTx: SIGN_TX,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      invoke: true,
      operatorConfirmed: true,
      deps: {
        pending: signedPending(),
        assembled: goodAssembled,
        arbNonce: {
          ok: true,
          mpc_nonce: 0,
          expected_nonce: 0,
          nonce_available_for_broadcast: true,
        },
        proposeReceiptVerify: { ok: true },
        adapters: viewAdapters(),
        journal,
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "journal_conflicting_signed_bytes");
  });

  it("NO-GO on bad Arb nonce / pending tx", async () => {
    const op = "op-j8bs-persist-nonce";
    await createSignedAuth(op);
    const r = await persistSignedRawCanary({
      operationId: op,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      invoke: true,
      operatorConfirmed: true,
      deps: {
        pending: signedPending(),
        assembled: goodAssembled,
        arbNonce: {
          ok: true,
          mpc_nonce: 1,
          expected_nonce: 0,
          nonce_available_for_broadcast: false,
          possible_prior_broadcast: true,
        },
        proposeReceiptVerify: { ok: true },
        adapters: viewAdapters(),
      },
    });
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /arb_nonce/);
  });

  it("NO-GO when policy not paused", async () => {
    const op = "op-j8bs-persist-unpaused";
    await createSignedAuth(op);
    const r = await persistSignedRawCanary({
      operationId: op,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      invoke: true,
      operatorConfirmed: true,
      deps: {
        pending: signedPending(),
        assembled: goodAssembled,
        arbNonce: {
          ok: true,
          mpc_nonce: 0,
          expected_nonce: 0,
          nonce_available_for_broadcast: true,
        },
        proposeReceiptVerify: { ok: true },
        adapters: {
          getPaused: async () => false,
          getMandateEpoch: async () => 2,
          getPending: async () => signedPending(),
        },
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "policy_must_remain_paused_for_persist");
  });

  it("NO-GO on wrong recovered signer at persist", async () => {
    const op = "op-j8bs-persist-badsig";
    await createSignedAuth(op);
    const r = await persistSignedRawCanary({
      operationId: op,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      invoke: true,
      operatorConfirmed: true,
      deps: {
        pending: signedPending(),
        assembled: {
          ...goodAssembled,
          recovered: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        },
        arbNonce: {
          ok: true,
          mpc_nonce: 0,
          expected_nonce: 0,
          nonce_available_for_broadcast: true,
        },
        proposeReceiptVerify: { ok: true },
        adapters: viewAdapters(),
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "recovered_address_mismatch");
  });

  it("preserves FAILED original/recovery integrity across persist", async () => {
    const op = "op-j8bs-persist-integrity";
    const original = seedFailedOriginal(op);
    const prior = seedFailedRecovery(op, original);
    await createSignedTxRecoveryAuthorization({
      operationId: op,
      nearSignTx: SIGN_TX,
      nearProposeTx: "HnpL7Sh2E7QPSi4rq1sefDQV4nYayFnKpkvbU2NUdzad",
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      operatorConfirmed: true,
      deps: {
        pending: signedPending(),
        nearTx: txWithReceipts([mpcSv(sampleSig()), mpcSv(sampleSig())], {
          logs: [
            `EVENT_JSON:${JSON.stringify({ event: "signed", operation_id: op })}`,
          ],
        }),
        assembled: goodAssembled,
        arbNonce: {
          ok: true,
          mpc_nonce: 0,
          expected_nonce: 0,
          nonce_available_for_broadcast: true,
        },
        proposeReceiptVerify: { ok: true },
        adapters: viewAdapters(),
      },
    });
    const macOrig = original.record.mac;
    const macPrior = prior.macBefore;
    const r = await persistSignedRawCanary({
      operationId: op,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      invoke: true,
      operatorConfirmed: true,
      deps: {
        pending: signedPending(),
        assembled: goodAssembled,
        arbNonce: {
          ok: true,
          mpc_nonce: 0,
          expected_nonce: 0,
          nonce_available_for_broadcast: true,
        },
        proposeReceiptVerify: { ok: true },
        adapters: viewAdapters(),
        journalPath: join(STORE, `journal-${op}.sqlite`),
      },
    });
    assert.equal(r.ok, true);
    assert.equal(
      loadCanaryApproval(op, { storeDir: STORE, env: ENV }).record.mac,
      macOrig
    );
    assert.equal(
      loadRecoveryAuthorization(op, { storeDir: STORE, env: ENV }).record.mac,
      macPrior
    );
    assert.equal(
      loadCanaryApproval(op, { storeDir: STORE, env: ENV }).record
        .lifecycle_state,
      CANARY_STATES.FAILED
    );
    assert.equal(
      loadRecoveryAuthorization(op, { storeDir: STORE, env: ENV }).record
        .lifecycle_state,
      CANARY_STATES.FAILED
    );
  });
});
