/**
 * J8B-R — propose stale-RPC recovery + reserved-op resume tests (zero mutations).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createCanaryApproval,
  bindQuoteToApproval,
  validateCanaryApproval,
  validateExecutableApproval,
  consumeCanaryApproval,
  advanceLifecycle,
  confirmPhaseAfterOutcome,
  loadCanaryApproval,
  loadRecoveryAuthorization,
  CANARY_STATES,
  CANARY_AMOUNT,
} from "./canaryOneShot.mjs";
import { canaryStepPropose, canaryStepRequestSignature } from "./canaryExecutor.mjs";
import {
  waitForPendingOp,
  inspectReservedOperation,
  createRecoveryAuthorization,
  runRecoveryRehearsal,
} from "./canaryRecovery.mjs";
import { MAINNET_IDENTITIES } from "./identities.mjs";

const STORE = mkdtempSync(join(tmpdir(), "nio-j8br-"));
const ENV = { NIO_CANARY_HMAC_SECRET: "j8br-secret-key-32bytes-minimum!" };
const ESCROW = "0xcaa3dc3d6d2bb72ade403c614949e66d5ed37f1e";
const DIGEST =
  "b1811f74b1c61a67a9f0d80dfabbdd14e46904d5585f847b80c49801ea0640ed";
const OP = "j8b-canary-1794572720062-8db4f42a";

function reservedPending(overrides = {}) {
  return {
    epoch: 2,
    amount_in: { "": CANARY_AMOUNT },
    destination: ESCROW,
    payload_commitment: DIGEST,
    signing_state: "Reserved",
    settlement_state: "None",
    ...overrides,
  };
}

async function prepToUnpaused(op) {
  createCanaryApproval({
    operationId: op,
    storeDir: STORE,
    env: ENV,
    quoteHash: "Gs9eGyUUEJRDX41coUercha13ooBpfuUK3gdfKQTXkgG",
    depositAddress: ESCROW,
  });
  // bind already done via create args; ensure lifecycle
  for (const s of [
    CANARY_STATES.QUOTE_VERIFIED,
    CANARY_STATES.ATTESTED,
    CANARY_STATES.OWNER_UNPAUSED,
  ]) {
    advanceLifecycle(op, s, {
      storeDir: STORE,
      env: ENV,
      outcome:
        s === CANARY_STATES.ATTESTED
          ? {
              digest_hex: DIGEST,
              propose_args: {
                operation_id: op,
                attestation: { deposit_address: ESCROW },
                attestation_signature: "ed25519:sig",
              },
            }
          : {},
    });
  }
  const loaded = loadCanaryApproval(op, { storeDir: STORE, env: ENV });
  loaded.record.locked_digest_hex = DIGEST;
  loaded.record.locked_nonce = 0;
  loaded.record.locked_gas_price = "30000000";
  loaded.record.locked_gas_limit = "100000";
  const { writeFileSync } = await import("node:fs");
  writeFileSync(loaded.path, JSON.stringify(loaded.record, null, 2));
  confirmPhaseAfterOutcome(op, "propose", {
    storeDir: STORE,
    env: ENV,
    requiredState: CANARY_STATES.OWNER_UNPAUSED,
  });
}

after(() => {
  try {
    rmSync(STORE, { recursive: true, force: true });
  } catch {
    /* */
  }
});

describe("J8B-R waitForPendingOp", () => {
  it("retries null then succeeds", async () => {
    let n = 0;
    const r = await waitForPendingOp({
      operationId: OP,
      expectedDigest: DIGEST,
      attempts: 5,
      delayMs: 1,
      sleepFn: async () => {},
      adapters: {
        getPending: async () => {
          n += 1;
          return n < 3 ? null : reservedPending();
        },
        listPending: async () => [],
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.source, "get_pending");
    assert.ok(r.attempts >= 3);
  });

  it("finds via list_pending when get_pending stays null", async () => {
    const r = await waitForPendingOp({
      operationId: OP,
      expectedDigest: DIGEST,
      attempts: 3,
      delayMs: 1,
      sleepFn: async () => {},
      adapters: {
        getPending: async () => null,
        listPending: async () => [
          { operation_id: OP, ...reservedPending() },
        ],
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.source, "list_pending");
  });

  it("returns temporarily_unverified after exhausted nulls", async () => {
    const r = await waitForPendingOp({
      operationId: OP,
      expectedDigest: DIGEST,
      attempts: 3,
      delayMs: 1,
      sleepFn: async () => {},
      adapters: {
        getPending: async () => null,
        listPending: async () => [],
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "pending_op_temporarily_unverified");
  });

  it("detects true commitment mismatch", async () => {
    const r = await waitForPendingOp({
      operationId: OP,
      expectedDigest: DIGEST,
      attempts: 2,
      delayMs: 1,
      sleepFn: async () => {},
      adapters: {
        getPending: async () =>
          reservedPending({ payload_commitment: "aa".repeat(32) }),
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "payload_commitment_mismatch");
  });
});

describe("J8B-R propose verification", () => {
  it("successful propose with null immediate read then retry → PROPOSED", async () => {
    const op = "op-stale-ok";
    await prepToUnpaused(op);
    let calls = 0;
    const r = await canaryStepPropose({
      operationId: op,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      invoke: true,
      deps: {
        pendingAttempts: 4,
        pendingDelayMs: 1,
        sleepFn: async () => {},
        adapters: {
          getPaused: async () => false,
          getMandateEpoch: async () => 2,
          getPending: async () => {
            calls += 1;
            // first call is pre-check existing; then post-propose waits
            if (calls === 1) return null;
            if (calls < 4) return null;
            return reservedPending();
          },
          listPending: async () => [],
          proposeQuotedEvmTransfer: async () => ({
            ok: true,
            transaction_hash: "nearProposeTx1",
          }),
        },
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.stage, CANARY_STATES.PROPOSED);
    assert.equal(r.may_resubmit_propose, undefined);
  });

  it("null after retries → RECONCILIATION_REQUIRED without consume", async () => {
    const op = "op-recon-req";
    await prepToUnpaused(op);
    const r = await canaryStepPropose({
      operationId: op,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      invoke: true,
      deps: {
        pendingAttempts: 3,
        pendingDelayMs: 1,
        sleepFn: async () => {},
        adapters: {
          getPaused: async () => false,
          getMandateEpoch: async () => 2,
          getPending: async () => null,
          listPending: async () => [],
          proposeQuotedEvmTransfer: async () => ({
            ok: true,
            transaction_hash: "HKvxVGMZ9VwsEmDzmDmLdPsJ9og2G5Cx7HVLgDZGm45P",
          }),
        },
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "reconciliation_required");
    assert.equal(r.may_resubmit_propose, false);
    const loaded = loadCanaryApproval(op, { storeDir: STORE, env: ENV });
    assert.equal(loaded.record.used, false);
    assert.equal(
      loaded.record.lifecycle_state,
      CANARY_STATES.RECONCILIATION_REQUIRED
    );
  });

  it("blocks resubmit when already on-chain reserved", async () => {
    const op = "op-dup";
    await prepToUnpaused(op);
    const r = await canaryStepPropose({
      operationId: op,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      invoke: true,
      deps: {
        adapters: {
          getPaused: async () => false,
          getMandateEpoch: async () => 2,
          getPending: async () => reservedPending(),
          proposeQuotedEvmTransfer: async () => {
            throw new Error("must_not_propose");
          },
        },
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "already_on_chain_reserved");
  });

  it("blocks propose after reconciliation_required", async () => {
    const op = "op-no-resubmit";
    await prepToUnpaused(op);
    advanceLifecycle(op, CANARY_STATES.RECONCILIATION_REQUIRED, {
      storeDir: STORE,
      env: ENV,
      outcome: { near_tx: "x" },
    });
    const r = await canaryStepPropose({
      operationId: op,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      invoke: true,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "reconciliation_required_no_resubmit");
  });

  it("true mismatch still fails closed", async () => {
    const op = "op-mismatch";
    await prepToUnpaused(op);
    const r = await canaryStepPropose({
      operationId: op,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      invoke: true,
      deps: {
        pendingAttempts: 2,
        pendingDelayMs: 1,
        sleepFn: async () => {},
        adapters: {
          getPaused: async () => false,
          getMandateEpoch: async () => 2,
          getPending: async () => null,
          listPending: async () => [
            {
              operation_id: op,
              ...reservedPending({ payload_commitment: "bb".repeat(32) }),
            },
          ],
          proposeQuotedEvmTransfer: async () => ({
            ok: true,
            transaction_hash: "nearBad",
          }),
        },
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "payload_commitment_mismatch");
    const loaded = loadCanaryApproval(op, { storeDir: STORE, env: ENV });
    assert.equal(loaded.record.used, true);
  });
});

describe("J8B-R recovery authorization", () => {
  it("inspect marks SAFE when Reserved matches digest/escrow/amount", async () => {
    const op = "op-inspect-safe";
    createCanaryApproval({
      operationId: op,
      storeDir: STORE,
      env: ENV,
      quoteHash: "h",
      depositAddress: ESCROW,
    });
    const loaded = loadCanaryApproval(op, { storeDir: STORE, env: ENV });
    loaded.record.used = true;
    loaded.record.lifecycle_state = CANARY_STATES.FAILED;
    loaded.record.consume_reason = "payload_commitment_mismatch";
    loaded.record.locked_digest_hex = DIGEST;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(loaded.path, JSON.stringify(loaded.record, null, 2));

    const insp = await inspectReservedOperation({
      operationId: op,
      nearProposeTx: "HKvxVGMZ9VwsEmDzmDmLdPsJ9og2G5Cx7HVLgDZGm45P",
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      deps: {
        pending: reservedPending(),
        listPending: [{ operation_id: op, ...reservedPending() }],
        adapters: {
          getPaused: async () => true,
          getMandateEpoch: async () => 2,
          getPending: async () => reservedPending(),
        },
      },
    });
    assert.equal(insp.verdict, "SAFE_TO_RESUME_ORIGINAL_OPERATION");
    assert.equal(insp.checks.signing_reserved, true);
    assert.equal(insp.policy_paused_onchain, true);
  });

  it("refuses recovery without operatorConfirmed; creates immutable recovery auth", async () => {
    const op = "op-recovery-create";
    createCanaryApproval({
      operationId: op,
      storeDir: STORE,
      env: ENV,
      quoteHash: "h",
      depositAddress: ESCROW,
    });
    const loaded = loadCanaryApproval(op, { storeDir: STORE, env: ENV });
    const macBefore = loaded.record.mac;
    loaded.record.used = true;
    loaded.record.lifecycle_state = CANARY_STATES.FAILED;
    loaded.record.consume_reason = "payload_commitment_mismatch";
    loaded.record.locked_digest_hex = DIGEST;
    loaded.record.locked_nonce = 0;
    loaded.record.locked_gas_price = "30000000";
    loaded.record.locked_gas_limit = "100000";
    const { writeFileSync } = await import("node:fs");
    writeFileSync(loaded.path, JSON.stringify(loaded.record, null, 2));

    const denied = await createRecoveryAuthorization({
      operationId: op,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      operatorConfirmed: false,
    });
    assert.equal(denied.ok, false);

    const created = await createRecoveryAuthorization({
      operationId: op,
      nearProposeTx: "HKvxVGMZ9VwsEmDzmDmLdPsJ9og2G5Cx7HVLgDZGm45P",
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      operatorConfirmed: true,
      deps: {
        pending: reservedPending(),
        adapters: {
          getPaused: async () => true,
          getMandateEpoch: async () => 2,
          getPending: async () => reservedPending(),
          listPending: async () => [],
        },
      },
    });
    assert.equal(created.ok, true);
    assert.equal(created.verdict, "SAFE_TO_RESUME_ORIGINAL_OPERATION");
    assert.equal(created.forbids_propose, true);

    const orig = loadCanaryApproval(op, { storeDir: STORE, env: ENV });
    assert.equal(orig.record.used, true);
    assert.equal(orig.record.mac, macBefore);
    assert.equal(orig.record.lifecycle_state, CANARY_STATES.FAILED);

    const rec = loadRecoveryAuthorization(op, { storeDir: STORE, env: ENV });
    assert.equal(rec.ok, true);
    assert.equal(rec.record.lifecycle_state, CANARY_STATES.PROPOSED);
    assert.equal(rec.record.payload.forbids_propose, true);

    const proposeBlocked = await canaryStepPropose({
      operationId: op,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      invoke: true,
    });
    assert.equal(proposeBlocked.ok, false);
    assert.equal(proposeBlocked.reason, "propose_forbidden_recovery_auth_exists");

    const v = validateExecutableApproval(op, {
      storeDir: STORE,
      env: ENV,
      requireQuoteBound: true,
      allowRecovery: true,
    });
    assert.equal(v.ok, true);
    assert.equal(v.is_recovery, true);
  });

  it("NO-GO when already Signed", async () => {
    const op = "op-already-signed";
    createCanaryApproval({
      operationId: op,
      storeDir: STORE,
      env: ENV,
      quoteHash: "h",
      depositAddress: ESCROW,
    });
    const loaded = loadCanaryApproval(op, { storeDir: STORE, env: ENV });
    loaded.record.used = true;
    loaded.record.lifecycle_state = CANARY_STATES.FAILED;
    loaded.record.locked_digest_hex = DIGEST;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(loaded.path, JSON.stringify(loaded.record, null, 2));

    const insp = await inspectReservedOperation({
      operationId: op,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      deps: {
        pending: reservedPending({ signing_state: "Signed" }),
        adapters: {
          getPaused: async () => true,
          getMandateEpoch: async () => 2,
          getPending: async () => reservedPending({ signing_state: "Signed" }),
        },
      },
    });
    assert.equal(insp.verdict, "NO-GO");
    assert.equal(insp.safe_to_create_recovery_auth, false);
  });

  it("expired recovery auth fails validation", async () => {
    const op = "op-rec-expired";
    createCanaryApproval({
      operationId: op,
      storeDir: STORE,
      env: ENV,
      quoteHash: "h",
      depositAddress: ESCROW,
    });
    const loaded = loadCanaryApproval(op, { storeDir: STORE, env: ENV });
    loaded.record.used = true;
    loaded.record.lifecycle_state = CANARY_STATES.FAILED;
    loaded.record.locked_digest_hex = DIGEST;
    loaded.record.locked_nonce = 0;
    loaded.record.locked_gas_price = "1";
    loaded.record.locked_gas_limit = "1";
    const { writeFileSync } = await import("node:fs");
    writeFileSync(loaded.path, JSON.stringify(loaded.record, null, 2));
    await createRecoveryAuthorization({
      operationId: op,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      operatorConfirmed: true,
      ttlMs: 1,
      deps: {
        pending: reservedPending(),
        adapters: {
          getPaused: async () => true,
          getMandateEpoch: async () => 2,
          getPending: async () => reservedPending(),
        },
      },
    });
    const v = validateExecutableApproval(op, {
      storeDir: STORE,
      env: ENV,
      allowRecovery: true,
      nowMs: Date.now() + 60_000,
    });
    assert.equal(v.ok, false);
    assert.equal(v.reason, "approval_expired");
  });

  it("unsafe resume: sign without recovery when original consumed", async () => {
    const op = "op-unsafe-resume";
    createCanaryApproval({
      operationId: op,
      storeDir: STORE,
      env: ENV,
      quoteHash: "h",
      depositAddress: ESCROW,
    });
    consumeCanaryApproval(op, {
      storeDir: STORE,
      env: ENV,
      reason: "payload_commitment_mismatch",
    });
    const r = await canaryStepRequestSignature({
      operationId: op,
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      invoke: false,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "approval_already_used");
  });

  it("zero-mutation recovery rehearsal", async () => {
    const op = "op-rehearse";
    createCanaryApproval({
      operationId: op,
      storeDir: STORE,
      env: ENV,
      quoteHash: "h",
      depositAddress: ESCROW,
    });
    const loaded = loadCanaryApproval(op, { storeDir: STORE, env: ENV });
    loaded.record.used = true;
    loaded.record.lifecycle_state = CANARY_STATES.FAILED;
    loaded.record.locked_digest_hex = DIGEST;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(loaded.path, JSON.stringify(loaded.record, null, 2));
    const r = await runRecoveryRehearsal({
      operationId: op,
      nearProposeTx: "HKvxVGMZ9VwsEmDzmDmLdPsJ9og2G5Cx7HVLgDZGm45P",
      storeDir: STORE,
      env: ENV,
      testHarness: true,
      deps: {
        pending: reservedPending(),
        adapters: {
          getPaused: async () => true,
          getMandateEpoch: async () => 2,
          getPending: async () => reservedPending(),
        },
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.mutations_invoked, false);
    assert.equal(r.verdict, "SAFE_TO_RESUME_ORIGINAL_OPERATION");
  });
});
