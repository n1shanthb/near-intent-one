/**
 * J8B-BR — broadcast-only reauthorization for journaled signed tx (zero live mutations).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createCanaryApproval,
  loadCanaryApproval,
  loadRecoveryAuthorization,
  loadSignedTxRecoveryAuthorization,
  loadBroadcastReauthAuthorization,
  validateExecutableApproval,
  signApprovalPayload,
  CANARY_STATES,
  CANARY_AMOUNT,
  RECOVERY_KIND,
  SIGNED_TX_RECOVERY_KIND,
  BROADCAST_REAUTH_KIND,
} from "./canaryOneShot.mjs";
import {
  inspectBroadcastReauth,
  createBroadcastReauthAuthorization,
  checkArbExistingTx,
} from "./canaryBroadcastReauth.mjs";
import { canaryStepRequestSignature, canaryStepBroadcast } from "./canaryExecutor.mjs";
import { resolveCanaryUnlock, assertMainnetBroadcastAllowed } from "./safetyGates.mjs";
import { broadcastWithJournal } from "../execution/durableBroadcast.mjs";
import { openTxJournal, localTxHash, TX_STATE } from "../execution/txJournal.mjs";
import { MAINNET_1CLICK } from "../execution/chainProfiles.mjs";
import { MAINNET_IDENTITIES } from "./identities.mjs";

const STORE = mkdtempSync(join(tmpdir(), "nio-j8br-br-"));
const ENV = {
  NIO_CANARY_HMAC_SECRET: "j8br-br-secret-key-32bytes-min!!",
  NIO_JOURNAL_SECRET: "j8br-br-journal-secret-32bytes!!",
};
const ESCROW = "0xcaa3dc3d6d2bb72ade403c614949e66d5ed37f1e";
const DIGEST =
  "b1811f74b1c61a67a9f0d80dfabbdd14e46904d5585f847b80c49801ea0640ed";
const LOCAL =
  "a4d159fec8eca4e7bed01c6ed3b25e65ded7519dce47f9fd422fb6e9a55c9664";
const SIGN_TX = "27VQYinCZFddL6aXzyajktex6dbEJsjjVdUVD5KjsPVp";
const PROPOSE_TX = "HnpL7Sh2E7QPSi4rq1sefDQV4nYayFnKpkvbU2NUdzad";
const MPC = MAINNET_IDENTITIES.mpc_evm_address.toLowerCase();
const SAMPLE_RAW = "0x" + "ab".repeat(120);

after(() => {
  try {
    rmSync(STORE, { recursive: true, force: true });
  } catch {
    /* */
  }
});

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
  const expires_at = new Date(Date.now() - 60_000).toISOString();
  const payload = {
    ...original.record.payload,
    expires_at,
    kind: RECOVERY_KIND,
    recovery_of_fingerprint: original.record.fingerprint,
    near_propose_tx: PROPOSE_TX,
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

function seedExpiredSignedRecovery(op, original) {
  const expires_at = new Date(Date.now() - 60_000).toISOString();
  const payload = {
    ...original.record.payload,
    expires_at,
    kind: SIGNED_TX_RECOVERY_KIND,
    recovery_of_fingerprint: original.record.fingerprint,
    near_propose_tx: PROPOSE_TX,
    near_sign_tx: SIGN_TX,
    forbids_propose: true,
    forbids_request_signature: true,
    digest_hex: DIGEST,
    local_tx_hash: LOCAL,
    recovered_signer: MPC,
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
    lifecycle_state: CANARY_STATES.READY_TO_BROADCAST,
    locked_digest_hex: DIGEST,
    locked_local_tx_hash: LOCAL,
    locked_broadcast_hash: null,
    locked_nonce: 0,
    locked_gas_price: "30000000",
    locked_gas_limit: "100000",
    base_usdc_before: "0",
    outcomes: {
      QUOTE_VERIFIED: {
        min_out: "994904",
        quote_deadline_ms: Date.now() + 3_600_000,
        quote_hash: original.record.payload.quote_hash,
        deposit: ESCROW,
      },
      READY_TO_BROADCAST: {
        at: new Date().toISOString(),
        local_tx_hash: LOCAL,
        near_sign_tx: SIGN_TX,
      },
    },
  };
  const path = join(STORE, `signed-recovery-${op}.json`);
  writeFileSync(path, JSON.stringify(record, null, 2));
  return { record, path, macBefore: mac, snap: JSON.stringify(record) };
}

function journalOk(overrides = {}) {
  return {
    ok: true,
    local_tx_hash: LOCAL,
    journal_state: TX_STATE.SIGNED,
    recovered: MPC,
    digest_hex: DIGEST,
    raw_present: true,
    decoded_public: {
      chain_id: 42161,
      nonce: 0,
      to: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
      gas_price: "30000000",
      gas_limit: "100000",
      digest_hex: DIGEST,
      escrow: ESCROW,
      amount: CANARY_AMOUNT,
      recovered: MPC,
    },
    ...overrides,
  };
}

function goodDeps(extra = {}) {
  return {
    pending: {
      epoch: 2,
      signing_state: "Signed",
      settlement_state: "None",
      payload_commitment: DIGEST,
      destination: ESCROW,
      amount_in: CANARY_AMOUNT,
    },
    journalVerify: journalOk(),
    arbNonce: {
      ok: true,
      mpc_nonce: 0,
      mpc_nonce_pending: 0,
      expected_nonce: 0,
      pending_tx_in_flight: false,
      nonce_available_for_broadcast: true,
      possible_prior_broadcast: false,
    },
    arbExistingTx: { ok: true, present: false, mined: false, pending: false },
    proposeReceiptVerify: { ok: true, independently_verified: true },
    quoteStatus: { ok: true, normalized: "PENDING", status: "PENDING_DEPOSIT" },
    adapters: {
      getPaused: async () => true,
      getMandateEpoch: async () => 2,
      getPending: async () => ({
        epoch: 2,
        signing_state: "Signed",
        settlement_state: "None",
        payload_commitment: DIGEST,
        destination: ESCROW,
      }),
    },
    ...extra,
  };
}

function seedAll(op) {
  const original = seedFailedOriginal(op);
  const prior = seedFailedRecovery(op, original);
  const signed = seedExpiredSignedRecovery(op, original);
  return { original, prior, signed };
}

describe("J8B-BR inspect + create broadcast-reauth", () => {
  it("inspect SAFE when journal/NEAR/Arb/quote all clear; no mutations", async () => {
    const op = "op-br-safe";
    seedAll(op);
    const insp = await inspectBroadcastReauth({
      operationId: op,
      nearSignTx: SIGN_TX,
      nearProposeTx: PROPOSE_TX,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      deps: goodDeps(),
    });
    assert.equal(insp.verdict, "SAFE_TO_CREATE_BROADCAST_REAUTH");
    assert.equal(insp.mutations_invoked, false);
    assert.equal(insp.safe_to_create_broadcast_reauth, true);
    assert.equal(insp.signed_recovery.expired, true);
    assert.equal(insp.checks.policy_paused, true);
  });

  it("refuses create without operator confirmation", async () => {
    const op = "op-br-no-confirm";
    seedAll(op);
    const denied = await createBroadcastReauthAuthorization({
      operationId: op,
      nearSignTx: SIGN_TX,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      operatorConfirmed: false,
      deps: goodDeps(),
    });
    assert.equal(denied.ok, false);
    assert.match(denied.reason, /operator_confirm_required/);
    assert.equal(existsSync(join(STORE, `broadcast-reauth-${op}.json`)), false);
  });

  it("creates broadcast-reauth without mutating prior FAILED/signed-recovery; forbids resign", async () => {
    const op = "op-br-create";
    const { original, prior, signed } = seedAll(op);
    const created = await createBroadcastReauthAuthorization({
      operationId: op,
      nearSignTx: SIGN_TX,
      nearProposeTx: PROPOSE_TX,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      operatorConfirmed: true,
      deps: goodDeps(),
    });
    assert.equal(created.ok, true);
    assert.equal(created.broadcast_invoked, false);
    assert.equal(created.forbids_request_signature, true);
    assert.equal(created.forbids_resign, true);
    assert.equal(created.forbids_tx_mutation, true);
    assert.equal(created.local_tx_hash, LOCAL);

    const origAfter = loadCanaryApproval(op, { storeDir: STORE, env: ENV });
    assert.equal(origAfter.record.mac, original.record.mac);
    assert.equal(origAfter.record.lifecycle_state, CANARY_STATES.FAILED);
    const priorAfter = loadRecoveryAuthorization(op, {
      storeDir: STORE,
      env: ENV,
    });
    assert.equal(priorAfter.record.mac, prior.macBefore);
    const signedAfter = loadSignedTxRecoveryAuthorization(op, {
      storeDir: STORE,
      env: ENV,
    });
    assert.equal(signedAfter.record.mac, signed.macBefore);
    assert.equal(JSON.stringify(signedAfter.record), signed.snap);
    assert.ok(
      Date.parse(signedAfter.record.payload.expires_at) < Date.now(),
      "signed-recovery must remain expired"
    );

    const v = validateExecutableApproval(op, {
      storeDir: STORE,
      env: ENV,
      requireQuoteBound: true,
    });
    assert.equal(v.ok, true);
    assert.equal(v.is_broadcast_reauth, true);
    assert.equal(v.payload.kind, BROADCAST_REAUTH_KIND);

    const unlock = resolveCanaryUnlock(
      {
        operationId: op,
        storeDir: STORE,
        allowRecovery: true,
        requireQuoteBound: true,
        expected: { digest_hex: DIGEST, local_tx_hash: LOCAL },
      },
      ENV
    );
    assert.equal(unlock.ok, true);
    assert.equal(unlock.mode, "one_shot_canary_broadcast_reauth");
    assert.equal(unlock.allows_sign, false);
    assert.equal(unlock.allows_broadcast, true);

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

  it("NO-GO duplicate authorization", async () => {
    const op = "op-br-dup";
    seedAll(op);
    const first = await createBroadcastReauthAuthorization({
      operationId: op,
      nearSignTx: SIGN_TX,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      operatorConfirmed: true,
      deps: goodDeps(),
    });
    assert.equal(first.ok, true);
    const second = await createBroadcastReauthAuthorization({
      operationId: op,
      nearSignTx: SIGN_TX,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      operatorConfirmed: true,
      deps: goodDeps(),
    });
    assert.equal(second.ok, false);
    assert.match(second.reason, /unsafe|already_exists/);
  });

  it("NO-GO on expired broadcast-reauth (does not fall through to signed-recovery)", async () => {
    const op = "op-br-expiry";
    seedAll(op);
    const created = await createBroadcastReauthAuthorization({
      operationId: op,
      nearSignTx: SIGN_TX,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      operatorConfirmed: true,
      ttlMs: 1,
      deps: goodDeps(),
    });
    assert.equal(created.ok, true);
    await new Promise((r) => setTimeout(r, 5));
    const v = validateExecutableApproval(op, {
      storeDir: STORE,
      env: ENV,
      requireQuoteBound: true,
      nowMs: Date.now() + 1000,
    });
    assert.equal(v.ok, false);
    assert.equal(v.reason, "approval_expired");
    assert.equal(v.is_signed_recovery, undefined);
  });

  it("NO-GO journal hash mismatch", async () => {
    const op = "op-br-hash";
    seedAll(op);
    const insp = await inspectBroadcastReauth({
      operationId: op,
      nearSignTx: SIGN_TX,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      deps: goodDeps({
        journalVerify: {
          ok: false,
          reason: "journal_local_tx_hash_mismatch",
          got: "ff".repeat(32),
          expected: LOCAL,
        },
      }),
    });
    assert.equal(insp.verdict, "NO-GO");
    assert.equal(insp.checks.journal_ok, false);
  });

  it("NO-GO journal corruption / bad state", async () => {
    const op = "op-br-corrupt";
    seedAll(op);
    const insp = await inspectBroadcastReauth({
      operationId: op,
      nearSignTx: SIGN_TX,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      deps: goodDeps({
        journalVerify: { ok: false, reason: "journal_bad_state:DRAFT" },
      }),
    });
    assert.equal(insp.verdict, "NO-GO");
  });

  it("NO-GO pending nonce in flight", async () => {
    const op = "op-br-pending-nonce";
    seedAll(op);
    const insp = await inspectBroadcastReauth({
      operationId: op,
      nearSignTx: SIGN_TX,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      deps: goodDeps({
        arbNonce: {
          ok: true,
          mpc_nonce: 0,
          mpc_nonce_pending: 1,
          expected_nonce: 0,
          pending_tx_in_flight: true,
          nonce_available_for_broadcast: false,
        },
      }),
    });
    assert.equal(insp.verdict, "NO-GO");
    assert.equal(insp.checks.arb_nonce_ok, false);
  });

  it("NO-GO existing mined/pending Arb tx", async () => {
    const op = "op-br-existing-tx";
    seedAll(op);
    const insp = await inspectBroadcastReauth({
      operationId: op,
      nearSignTx: SIGN_TX,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      deps: goodDeps({
        arbExistingTx: {
          ok: false,
          reason: "arb_tx_already_mined",
          present: true,
          mined: true,
          halt_broadcast: true,
        },
      }),
    });
    assert.equal(insp.verdict, "NO-GO");
    assert.equal(insp.checks.arb_existing_tx_clear, false);
  });

  it("NO-GO wrong escrow / deposit", async () => {
    const op = "op-br-escrow";
    seedAll(op);
    const insp = await inspectBroadcastReauth({
      operationId: op,
      nearSignTx: SIGN_TX,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      deps: goodDeps({
        pending: {
          epoch: 2,
          signing_state: "Signed",
          settlement_state: "None",
          payload_commitment: DIGEST,
          destination: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        },
      }),
    });
    assert.equal(insp.verdict, "NO-GO");
    assert.equal(insp.checks.deposit_match, false);
  });

  it("NO-GO bad recovered signature / journal verify failure", async () => {
    const op = "op-br-badsig";
    seedAll(op);
    const insp = await inspectBroadcastReauth({
      operationId: op,
      nearSignTx: SIGN_TX,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      deps: goodDeps({
        journalVerify: {
          ok: false,
          reason: "journal_recovered_signer_mismatch",
          got: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        },
      }),
    });
    assert.equal(insp.verdict, "NO-GO");
  });

  it("NO-GO stale quote deadline", async () => {
    const op = "op-br-quote";
    const { original } = seedAll(op);
    original.record.outcomes.QUOTE_VERIFIED.quote_deadline_ms =
      Date.now() - 60_000;
    writeFileSync(original.path, JSON.stringify(original.record, null, 2));
    const signed = loadSignedTxRecoveryAuthorization(op, {
      storeDir: STORE,
      env: ENV,
    });
    signed.record.outcomes.QUOTE_VERIFIED.quote_deadline_ms =
      Date.now() - 60_000;
    signed.record.payload.quote_deadline_ms = Date.now() - 60_000;
    const { mac, fingerprint } = signApprovalPayload(signed.record.payload, ENV);
    writeFileSync(
      signed.path,
      JSON.stringify({ ...signed.record, mac, fingerprint }, null, 2)
    );
    const insp = await inspectBroadcastReauth({
      operationId: op,
      nearSignTx: SIGN_TX,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      deps: goodDeps(),
    });
    assert.equal(insp.verdict, "NO-GO");
    assert.equal(insp.checks.quote_deadline_fresh, false);
  });

  it("NO-GO RPC ambiguity on existing-tx lookup", async () => {
    const r = await checkArbExistingTx({
      evmTxHash: "0x" + "11".repeat(32),
      eth: async () => {
        throw new Error("rpc_timeout");
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.halt_broadcast, true);
    assert.equal(r.reason, "arb_tx_lookup_ambiguous");
  });
});

describe("J8B-BR broadcast dry-run + crash-safe UNKNOWN", () => {
  it("broadcast dry-run under reauth does not send", async () => {
    const op = "op-br-dry";
    seedAll(op);
    const created = await createBroadcastReauthAuthorization({
      operationId: op,
      nearSignTx: SIGN_TX,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      operatorConfirmed: true,
      deps: goodDeps(),
    });
    assert.equal(created.ok, true);
    // Operator confirm for broadcast phase
    const { recordOperatorConfirmation } = await import("./canaryOneShot.mjs");
    recordOperatorConfirmation(op, "broadcast", {
      storeDir: STORE,
      env: ENV,
      confirmed: true,
    });
    const dry = await canaryStepBroadcast({
      operationId: op,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      invoke: false,
    });
    assert.equal(dry.ok, true);
    assert.equal(dry.dry, true);
    assert.equal(dry.is_broadcast_reauth, true);
  });

  it("UNKNOWN journal blocks automatic second send", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nio-br-unk-"));
    const journal = openTxJournal({
      path: join(dir, "tx.sqlite"),
      secret: ENV.NIO_JOURNAL_SECRET,
    });
    const id = "op-br-unknown";
    journal.insertDraft({
      id,
      portfolio_id: "p1",
      idempotency_key: "idem-unk",
      nonce: "0",
      chain_id: "42161",
    });
    journal.markSigned(id, { signedRawHex: SAMPLE_RAW });
    journal.beginBroadcast(id);
    journal.markUnknown(id, { rpc_error: "timeout" });
    assert.equal(journal.get(id).state, TX_STATE.UNKNOWN);

    let sends = 0;
    const r = await broadcastWithJournal({
      journal,
      journalId: id,
      signedRawHex: SAMPLE_RAW,
      profile: { id: "test", network: "testnet", evm_chain_id: 42161 },
      eth: async () => {
        sends += 1;
        return { result: "0xabc" };
      },
      opts: { dryRun: false },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "journal_unknown_requires_reconcile");
    assert.equal(sends, 0);
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("already-broadcast journal skips duplicate send", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nio-br-dupb-"));
    const journal = openTxJournal({
      path: join(dir, "tx.sqlite"),
      secret: ENV.NIO_JOURNAL_SECRET,
    });
    const id = "op-br-already";
    journal.insertDraft({
      id,
      portfolio_id: "p1",
      idempotency_key: "idem-alr",
      nonce: "0",
      chain_id: "42161",
    });
    journal.markSigned(id, { signedRawHex: SAMPLE_RAW });
    journal.beginBroadcast(id);
    journal.markBroadcast(id, "0x" + "22".repeat(32));

    let sends = 0;
    const r = await broadcastWithJournal({
      journal,
      journalId: id,
      signedRawHex: SAMPLE_RAW,
      profile: { id: "test", network: "testnet", evm_chain_id: 42161 },
      eth: async () => {
        sends += 1;
        return { result: "0xshould_not" };
      },
      opts: { dryRun: false },
    });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
    assert.equal(sends, 0);
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("global funded gates stay hard-false without canary reauth", () => {
    const gate = assertMainnetBroadcastAllowed({
      ...ENV,
      NIO_MAINNET_ALLOW_BROADCAST: "1",
      NIO_FUNDED_TRADING: "1",
    });
    assert.equal(gate.ok, false);
    assert.equal(gate.gates.mainnet_broadcast_enabled, false);
    assert.equal(gate.gates.funded_trading, false);
  });
});

void localTxHash;
void MAINNET_1CLICK;
void readFileSync;
