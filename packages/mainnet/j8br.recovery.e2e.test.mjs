/**
 * J8B-R final — end-to-end simulated recovery lifecycle (zero mainnet mutations).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createCanaryApproval,
  loadCanaryApproval,
  loadRecoveryAuthorization,
  confirmPhaseAfterOutcome,
  advanceLifecycle,
  validateExecutableApproval,
  CANARY_STATES,
  CANARY_AMOUNT,
  CANARY_TOKEN,
} from "./canaryOneShot.mjs";
import {
  createRecoveryAuthorization,
  verifyNearProposeReceipt,
} from "./canaryRecovery.mjs";
import {
  canaryStepPropose,
  canaryStepRequestSignature,
  canaryStepBroadcast,
  canaryStepSettle,
  canaryStepReconcilePending,
} from "./canaryExecutor.mjs";
import { resolveCanaryUnlock, assertMainnetBroadcastAllowed } from "./safetyGates.mjs";
import { broadcastWithJournal } from "../execution/durableBroadcast.mjs";
import { openTxJournal, localTxHash } from "../execution/txJournal.mjs";
import { MAINNET_1CLICK } from "../execution/chainProfiles.mjs";
import { MAINNET_IDENTITIES } from "./identities.mjs";
import {
  serializeSignedTx,
  erc20TransferData,
  eip155UnsignedDigest,
  digestHex,
} from "../intents-codec/quote-auth.mjs";
import { secp256k1 } from "@noble/curves/secp256k1";
import { evmAddressFromPubkey } from "../intents-codec/eip191.mjs";

const STORE = mkdtempSync(join(tmpdir(), "nio-j8br-e2e-"));
const ENV = {
  NIO_CANARY_HMAC_SECRET: "j8br-e2e-secret-key-32bytes-min!!",
  NIO_JOURNAL_SECRET: "j8br-e2e-journal-secret-32bytes!!",
};
const ESCROW = "0xcaa3dc3d6d2bb72ade403c614949e66d5ed37f1e";
const NEAR_TX = "HKvxVGMZ9VwsEmDzmDmLdPsJ9og2G5Cx7HVLgDZGm45P";

after(() => {
  try {
    rmSync(STORE, { recursive: true, force: true });
  } catch {
    /* */
  }
});

function makeSignedRaw({ nonce, gasPrice, gasLimit, deposit, amount, privateKey }) {
  const data = erc20TransferData(deposit, amount);
  const digest = eip155UnsignedDigest({
    nonce: BigInt(nonce),
    gasPrice: BigInt(gasPrice),
    gasLimit: BigInt(gasLimit),
    to: CANARY_TOKEN,
    data,
    chainId: 42161,
  });
  const sig = secp256k1.sign(digest, privateKey);
  const recoveryId = sig.recovery;
  const raw = serializeSignedTx({
    nonce: BigInt(nonce),
    gasPrice: BigInt(gasPrice),
    gasLimit: BigInt(gasLimit),
    to: CANARY_TOKEN,
    data,
    chainId: 42161,
    r: sig.toCompactRawBytes().slice(0, 32),
    s: sig.toCompactRawBytes().slice(32, 64),
    recoveryId,
  });
  return { raw, digest_hex: digestHex(digest) };
}

async function seedFailedOriginal(op, { digest, priv }) {
  createCanaryApproval({
    operationId: op,
    storeDir: STORE,
    env: ENV,
    quoteHash: "Gs9eGyUUEJRDX41coUercha13ooBpfuUK3gdfKQTXkgG",
    depositAddress: ESCROW,
  });
  const loaded = loadCanaryApproval(op, { storeDir: STORE, env: ENV });
  const pub = secp256k1.getPublicKey(priv, false);
  // Force MPC identity match is hard without the real MPC key; tests that
  // need recover use deps.assembled / verify mocks. Digest locked here.
  void pub;
  loaded.record.used = true;
  loaded.record.lifecycle_state = CANARY_STATES.FAILED;
  loaded.record.consume_reason = "payload_commitment_mismatch";
  loaded.record.locked_digest_hex = digest;
  loaded.record.locked_nonce = 0;
  loaded.record.locked_gas_price = "30000000";
  loaded.record.locked_gas_limit = "100000";
  loaded.record.base_usdc_before = "0";
  loaded.record.outcomes = {
    QUOTE_VERIFIED: {
      min_out: "994904",
      quote_deadline_ms: Date.now() + 3_600_000,
      quote_hash: loaded.record.payload.quote_hash,
      deposit: ESCROW,
    },
    ATTESTED: {
      min_out: "994904",
      quote_deadline_ms: Date.now() + 3_600_000,
      digest_hex: digest,
      propose_args: {
        attestation: {
          recipient: MAINNET_IDENTITIES.mpc_evm_address,
          refund_to: MAINNET_IDENTITIES.mpc_evm_address,
        },
      },
    },
  };
  writeFileSync(loaded.path, JSON.stringify(loaded.record, null, 2));
  return loaded;
}

describe("J8B-R recovery broadcast authorization", () => {
  it("durableBroadcast accepts recovery unlock with allowRecovery", async () => {
    const op = "op-bcast-auth";
    const digest = "aa".repeat(32);
    const priv = secp256k1.utils.randomPrivateKey();
    await seedFailedOriginal(op, { digest, priv });
    const created = await createRecoveryAuthorization({
      operationId: op,
      nearProposeTx: NEAR_TX,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      operatorConfirmed: true,
      deps: {
        pending: {
          epoch: 2,
          amount_in: { "": CANARY_AMOUNT },
          destination: ESCROW,
          payload_commitment: digest,
          signing_state: "Reserved",
          settlement_state: "None",
        },
        nearReceiptVerify: { ok: true, independently_verified: true },
        adapters: {
          getPaused: async () => true,
          getMandateEpoch: async () => 2,
          getPending: async () => ({
            payload_commitment: digest,
            signing_state: "Reserved",
            settlement_state: "None",
            epoch: 2,
            amount_in: { "": CANARY_AMOUNT },
            destination: ESCROW,
          }),
        },
      },
    });
    assert.equal(created.ok, true);

    const unlock = resolveCanaryUnlock(
      {
        operationId: op,
        storeDir: STORE,
        allowRecovery: true,
        requireQuoteBound: true,
        expected: { digest_hex: digest },
      },
      ENV
    );
    assert.equal(unlock.ok, true);
    assert.equal(unlock.mode, "one_shot_canary_recovery");
    assert.equal(unlock.scoped_operation_only, true);

    const noRecovery = resolveCanaryUnlock(
      {
        operationId: op,
        storeDir: STORE,
        allowRecovery: false,
        requireQuoteBound: true,
      },
      ENV
    );
    assert.equal(noRecovery.ok, false);

    const journal = openTxJournal({
      path: join(STORE, "bcast.sqlite"),
      secret: ENV.NIO_JOURNAL_SECRET,
    });
    journal.insertDraft({
      id: op,
      portfolio_id: "p",
      idempotency_key: op,
      nonce: "0",
      chain_id: "42161",
    });
    journal.markSigned(op, { signedRawHex: "0x" + "ab".repeat(80) });

    const denied = await broadcastWithJournal({
      journal,
      journalId: op,
      signedRawHex: "0x" + "ab".repeat(80),
      profile: MAINNET_1CLICK,
      eth: async () => ({ result: "0x1" }),
      opts: {
        dryRun: true,
        operationId: op,
        storeDir: STORE,
        env: ENV,
        allowRecovery: false,
        depositBound: { deposit_address: ESCROW, binding_ok: true },
      },
    });
    assert.equal(denied.ok, false);

    const allowed = await broadcastWithJournal({
      journal,
      journalId: op,
      signedRawHex: "0x" + "ab".repeat(80),
      profile: MAINNET_1CLICK,
      eth: async () => ({ result: "0x1" }),
      opts: {
        dryRun: true,
        operationId: op,
        storeDir: STORE,
        env: ENV,
        allowRecovery: true,
        expected: { digest_hex: digest },
        depositBound: { deposit_address: ESCROW, binding_ok: true },
      },
    });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.dry_run, true);

    const gate = assertMainnetBroadcastAllowed(ENV, {
      operationId: op,
      storeDir: STORE,
      allowRecovery: true,
      expected: { digest_hex: digest },
    });
    assert.equal(gate.ok, true);
    assert.equal(gate.is_recovery, true);
  });
});

describe("J8B-R recovery quote economics + e2e lifecycle", () => {
  it("recovery auth carries deadline/minOut; full simulated lifecycle", async () => {
    const op = "op-e2e-recovery";
    const digest = "bb".repeat(32);
    const priv = secp256k1.utils.randomPrivateKey();
    await seedFailedOriginal(op, { digest, priv });

    const created = await createRecoveryAuthorization({
      operationId: op,
      nearProposeTx: NEAR_TX,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      operatorConfirmed: true,
      deps: {
        pending: {
          epoch: 2,
          amount_in: { "": CANARY_AMOUNT },
          destination: ESCROW,
          payload_commitment: digest,
          signing_state: "Reserved",
          settlement_state: "None",
        },
        nearReceiptVerify: { ok: true, independently_verified: true },
        adapters: {
          getPaused: async () => true,
          getMandateEpoch: async () => 2,
          getPending: async () => ({
            payload_commitment: digest,
            signing_state: "Reserved",
            settlement_state: "None",
            epoch: 2,
            amount_in: { "": CANARY_AMOUNT },
            destination: ESCROW,
          }),
        },
      },
    });
    assert.equal(created.ok, true);
    const rec = loadRecoveryAuthorization(op, { storeDir: STORE, env: ENV });
    assert.equal(rec.record.payload.min_amount_out, "994904");
    assert.ok(rec.record.outcomes.QUOTE_VERIFIED.quote_deadline_ms);
    assert.equal(rec.record.payload.forbids_propose, true);
    assert.equal(rec.record.payload.kind, "one_shot_mainnet_canary_recovery_v1");

    // Tamper rejection
    const tampered = JSON.parse(JSON.stringify(rec.record));
    tampered.payload.near_propose_tx = "tampered";
    writeFileSync(rec.path, JSON.stringify(tampered, null, 2));
    const bad = validateExecutableApproval(op, {
      storeDir: STORE,
      env: ENV,
      allowRecovery: true,
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, "approval_mac_invalid");
    // restore
    writeFileSync(rec.path, JSON.stringify(rec.record, null, 2));

    // propose forbidden
    const p = await canaryStepPropose({
      operationId: op,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      invoke: true,
    });
    assert.equal(p.reason, "propose_forbidden_recovery_auth_exists");

    // sign dry after confirm
    confirmPhaseAfterOutcome(op, "sign", {
      storeDir: STORE,
      env: ENV,
      requiredState: CANARY_STATES.PROPOSED,
    });
    const signedRaw = makeSignedRaw({
      nonce: 0,
      gasPrice: "30000000",
      gasLimit: "100000",
      deposit: ESCROW,
      amount: CANARY_AMOUNT,
      privateKey: priv,
    });
    // Override digest lock to match assembled mock path
    const rec2 = loadRecoveryAuthorization(op, { storeDir: STORE, env: ENV });
    rec2.record.locked_digest_hex = signedRaw.digest_hex;
    rec2.record.payload.digest_hex = signedRaw.digest_hex;
    // Re-sign payload after digest change for MAC
    const { signApprovalPayload } = await import("./canaryOneShot.mjs");
    const signedPay = signApprovalPayload(rec2.record.payload, ENV);
    rec2.record.mac = signedPay.mac;
    rec2.record.fingerprint = signedPay.fingerprint;
    // Also update original fingerprint binding — recovery_of stays; digest in payload changed so MAC ok
    // But recovery_of_fingerprint still matches original — good
    writeFileSync(rec2.path, JSON.stringify(rec2.record, null, 2));

    // For unlock digest check vs original locked digest — original still has "bb"*32
    // Update original locked digest to match for unlock consistency (DO NOT in production —
    // e2e uses matching digests from the start). Re-seed path: patch original digest file.
    const orig = loadCanaryApproval(op, { storeDir: STORE, env: ENV });
    orig.record.locked_digest_hex = signedRaw.digest_hex;
    writeFileSync(orig.path, JSON.stringify(orig.record, null, 2));
    // recovery_of_fingerprint still matches original fingerprint (payload unchanged on original)

    const signDry = await canaryStepRequestSignature({
      operationId: op,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      invoke: false,
    });
    assert.equal(signDry.ok, true);
    assert.equal(signDry.is_recovery, true);

    // Simulate sign invoke with assembled mock (no real MPC)
    const signLive = await canaryStepRequestSignature({
      operationId: op,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      invoke: true,
      deps: {
        journalPath: join(STORE, "e2e-journal.sqlite"),
        pendingPreSign: {
          signing_state: "Reserved",
          payload_commitment: signedRaw.digest_hex,
          epoch: 2,
        },
        assembled: {
          ok: true,
          rawHex: signedRaw.raw,
          digest_hex: signedRaw.digest_hex,
          recovered: MAINNET_IDENTITIES.mpc_evm_address.toLowerCase(),
        },
        adapters: {
          getPaused: async () => false,
          getMandateEpoch: async () => 2,
          getPending: async () => ({
            signing_state: "Reserved",
            payload_commitment: signedRaw.digest_hex,
          }),
          requestSignature: async () => ({
            ok: true,
            transaction_hash: "nearSignTx",
          }),
          waitNearTx: async () => ({ result: { receipts_outcome: [] } }),
          verifySignedRawAgainstAuth: () => ({ ok: true }),
        },
      },
    });
    assert.equal(signLive.ok, true);
    assert.equal(signLive.stage, CANARY_STATES.READY_TO_BROADCAST);

    confirmPhaseAfterOutcome(op, "broadcast", {
      storeDir: STORE,
      env: ENV,
      requiredState: CANARY_STATES.READY_TO_BROADCAST,
    });

    const bcast = await canaryStepBroadcast({
      operationId: op,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      invoke: true,
      deps: {
        journalPath: join(STORE, "e2e-journal.sqlite"),
        pending: {
          payload_commitment: signedRaw.digest_hex,
          signing_state: "Signed",
        },
        adapters: {
          getPending: async () => ({
            payload_commitment: signedRaw.digest_hex,
            signing_state: "Signed",
          }),
          eth: async () => ({ result: "0x" + "cd".repeat(32) }),
          verifySignedRawAgainstAuth: () => ({
            ok: true,
            digest_hex: signedRaw.digest_hex,
            recovered: MAINNET_IDENTITIES.mpc_evm_address.toLowerCase(),
          }),
        },
      },
    });
    assert.equal(bcast.ok, true);
    assert.equal(bcast.stage, CANARY_STATES.SETTLEMENT_PENDING);

    const settle = await canaryStepSettle({
      operationId: op,
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
          ok: true,
          delta: "994904",
          min_amount_out: "994904",
        },
      },
    });
    assert.equal(settle.ok, true);
    assert.equal(settle.stage, CANARY_STATES.SETTLED);

    // Original still FAILED/used
    const origAfter = loadCanaryApproval(op, { storeDir: STORE, env: ENV });
    assert.equal(origAfter.record.used, true);
    assert.equal(origAfter.record.lifecycle_state, CANARY_STATES.FAILED);

    confirmPhaseAfterOutcome(op, "reconcile", {
      storeDir: STORE,
      env: ENV,
      requiredState: CANARY_STATES.SETTLED,
    });
    const recon = await canaryStepReconcilePending({
      operationId: op,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      invoke: true,
      evidenceHash: "e".repeat(64),
      deps: {
        reconciler: MAINNET_IDENTITIES.agent,
        adapters: {
          reconcilePending: async () => ({
            ok: true,
            transaction_hash: "nearRecon",
          }),
          getPending: async () => ({ settlement_state: "Success" }),
        },
      },
    });
    assert.equal(recon.ok, true);
    assert.equal(recon.stage, CANARY_STATES.RECONCILED);

    const recoveryFinal = loadRecoveryAuthorization(op, {
      storeDir: STORE,
      env: ENV,
    });
    assert.equal(
      recoveryFinal.record.lifecycle_state,
      CANARY_STATES.RECONCILED
    );
  });

  it("verifyNearProposeReceipt requires real logs not hash alone", () => {
    assert.equal(
      verifyNearProposeReceipt(null, { operationId: "x" }).ok,
      false
    );
    const ok = verifyNearProposeReceipt(
      {
        transaction_outcome: {
          outcome: {
            status: { SuccessValue: "" },
            logs: [
              'EVENT_JSON:{"event":"quoted_evm_reserved","operation_id":"op1","digest":"aa"}',
            ],
          },
        },
        receipts_outcome: [],
      },
      { operationId: "op1", expectedDigest: "aa" }
    );
    assert.equal(ok.ok, true);
    assert.equal(ok.independently_verified, true);
  });
});
