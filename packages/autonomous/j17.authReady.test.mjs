/**
 * J17.3 — authorization-ready tests (no live MPC / broadcast / register).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { openTxJournal } from "../execution/txJournal.mjs";
import {
  persistPreBroadcast,
  requireJournalSecret as execRequireJournalSecret,
  EXEC_MODE,
} from "./executorAdapter.mjs";
import {
  resolveJournalSecret,
  hydrateJournalSecretEnv,
  journalSecretFingerprint,
  createOperationIntent,
  advanceOperationIntent,
  findOpenOperationIntents,
  planNearMutation,
  evaluateNearMutationOutcome,
  requireLivePreflightForExecution,
  requireQuoteSignerRevokeAuth,
  AUTH_QUOTE_SIGNER_REVOKE,
  ATTESTOR_REVOCATION_PLAN,
  OP_INTENT_STATUS,
  AMOUNT_RAW,
  TEST_RECIPIENT,
} from "./j17.sepoliaPath.mjs";

describe("J17.3 journal secret path wiring", () => {
  it("resolves NIO_TX_JOURNAL_SECRET_PATH and hydrates writer env", () => {
    const dir = join(tmpdir(), `j17-sec-${Date.now()}-${randomBytes(2).toString("hex")}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "journal.secret");
    const secret = "a".repeat(48);
    writeFileSync(path, secret);
    try {
      const env = { NIO_TX_JOURNAL_SECRET_PATH: path };
      const resolved = resolveJournalSecret({ env, includeSecret: true });
      assert.equal(resolved.ok, true);
      assert.equal(resolved.source, "path_env");
      assert.equal(resolved.fingerprint, journalSecretFingerprint(secret));
      const hyd = hydrateJournalSecretEnv({ env, rootDir: null });
      assert.equal(hyd.ok, true);
      assert.equal(env.NIO_TX_JOURNAL_SECRET, secret);
      const writerSecret = execRequireJournalSecret({
        env,
        allowShadowFallback: false,
        operationId: "t1",
      });
      assert.equal(writerSecret, secret);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists with secret, restarts with same secret, fails if secret changes", async () => {
    const dir = join(tmpdir(), `j17-jnl-${Date.now()}-${randomBytes(2).toString("hex")}`);
    mkdirSync(dir, { recursive: true });
    const secretPath = join(dir, "journal.secret");
    const secret = randomBytes(32).toString("base64url");
    writeFileSync(secretPath, secret);
    const journalPath = join(dir, "tx.sqlite");
    const signedRaw = "0x" + "ab".repeat(64);
    try {
      process.env.NIO_TX_JOURNAL_SECRET_PATH = secretPath;
      delete process.env.NIO_TX_JOURNAL_SECRET;
      const persisted = await persistPreBroadcast({
        journalPath,
        operationId: "op-secret-1",
        signedRaw,
        nonce: "0",
        decisionHash: "d".repeat(64),
        network: "sepolia",
        mode: EXEC_MODE.TESTNET,
        defaultSecretPath: secretPath,
      });
      assert.equal(persisted.ok, true);

      // Restart with same secret
      const j1 = openTxJournal({ path: journalPath, secret });
      const raw1 = j1.loadSignedRaw("op-secret-1");
      assert.ok(raw1);
      assert.equal(raw1.replace(/^0x/, ""), signedRaw.replace(/^0x/, ""));
      j1.close();

      // Different secret must fail decrypt
      const j2 = openTxJournal({
        path: journalPath,
        secret: secret + "-different-must-fail-decrypt-xx",
      });
      assert.throws(() => j2.loadSignedRaw("op-secret-1"));
      j2.close();
      assert.equal(persisted.state, "SIGNED");
    } finally {
      delete process.env.NIO_TX_JOURNAL_SECRET_PATH;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* windows sqlite handle release */
      }
    }
  });
});

describe("J17.3 pre-propose intent + ambiguous NEAR", () => {
  it("locks intent before propose and resumes instead of minting a new op", () => {
    const dir = join(tmpdir(), `j17-intent-${Date.now()}-${randomBytes(2).toString("hex")}`);
    mkdirSync(dir, { recursive: true });
    try {
      const first = createOperationIntent({
        storeDir: dir,
        operationId: "j17-exec-aaa",
        epoch: 2,
        amount: AMOUNT_RAW,
        destination: TEST_RECIPIENT,
        nonce: 0,
        digestHex: "aa".repeat(32),
        gasLimit: "170366",
        gasPrice: "1000000000",
      });
      assert.equal(first.ok, true);
      assert.equal(first.resumed, false);
      assert.equal(first.record.status, OP_INTENT_STATUS.INTENT_LOCKED);

      const second = createOperationIntent({
        storeDir: dir,
        operationId: "j17-exec-bbb",
        epoch: 2,
        amount: AMOUNT_RAW,
        destination: TEST_RECIPIENT,
        nonce: 0,
        digestHex: "bb".repeat(32),
        gasLimit: "170366",
        gasPrice: "1000000000",
      });
      assert.equal(second.resumed, true);
      assert.equal(second.record.operation_id, "j17-exec-aaa");
      assert.equal(second.record.digest_hex, "aa".repeat(32));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("advances PROPOSED → PRE_SIGN_LOCKED and refuses duplicate propose/request", () => {
    const dir = join(tmpdir(), `j17-adv-${Date.now()}-${randomBytes(2).toString("hex")}`);
    mkdirSync(dir, { recursive: true });
    try {
      createOperationIntent({
        storeDir: dir,
        operationId: "op1",
        epoch: 2,
        amount: AMOUNT_RAW,
        destination: TEST_RECIPIENT,
        nonce: 0,
        digestHex: "cc".repeat(32),
        gasLimit: "170366",
        gasPrice: "1000000000",
      });
      assert.equal(
        planNearMutation({
          record: { status: OP_INTENT_STATUS.INTENT_LOCKED },
          method: "propose_quoted_evm_transfer",
        }).allowed,
        true
      );
      const proposed = advanceOperationIntent({
        storeDir: dir,
        operationId: "op1",
        status: OP_INTENT_STATUS.PROPOSED,
        patch: { propose_near_tx: "near-tx-1" },
      });
      assert.equal(
        planNearMutation({
          record: proposed.record,
          method: "propose_quoted_evm_transfer",
        }).may_duplicate_propose,
        false
      );
      const locked = advanceOperationIntent({
        storeDir: dir,
        operationId: "op1",
        status: OP_INTENT_STATUS.PRE_SIGN_LOCKED,
      });
      assert.equal(
        planNearMutation({
          record: locked.record,
          method: "request_signature",
        }).allowed,
        true
      );
      const ambiguous = evaluateNearMutationOutcome({
        method: "request_signature",
        priorStatus: OP_INTENT_STATUS.PRE_SIGN_LOCKED,
        ambiguous: true,
      });
      assert.equal(ambiguous.action, "QUARANTINE");
      assert.equal(ambiguous.may_new_operation, false);
      assert.equal(ambiguous.may_duplicate, false);
      advanceOperationIntent({
        storeDir: dir,
        operationId: "op1",
        status: ambiguous.next_status,
      });
      const reopen = findOpenOperationIntents(dir);
      assert.equal(reopen[0].record.status, OP_INTENT_STATUS.MPC_AMBIGUOUS);
      assert.equal(
        planNearMutation({
          record: reopen[0].record,
          method: "request_signature",
        }).allowed,
        false
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ambiguous propose outcome never allows a new operation", () => {
    const r = evaluateNearMutationOutcome({
      method: "propose_quoted_evm_transfer",
      priorStatus: OP_INTENT_STATUS.INTENT_LOCKED,
      ambiguous: true,
    });
    assert.equal(r.next_status, OP_INTENT_STATUS.PROPOSE_AMBIGUOUS);
    assert.equal(r.may_new_operation, false);
    assert.equal(
      planNearMutation({
        record: { status: OP_INTENT_STATUS.PROPOSE_AMBIGUOUS },
        method: "propose_quoted_evm_transfer",
      }).allowed,
      false
    );
  });
});

describe("J17.3 live preflight + revoke method", () => {
  it("auth/secret/preview alone are not execution success", () => {
    const a = requireLivePreflightForExecution({
      evidence: null,
      authEnabled: true,
    });
    assert.equal(a.ok, false);
    assert.ok(a.blockers.includes("auth_flag_alone_not_execution"));
    const s = requireLivePreflightForExecution({
      evidence: null,
      secretConfigured: true,
    });
    assert.ok(s.blockers.includes("secret_file_alone_not_execution"));
  });

  it("fresh live preflight with all gates can pass", () => {
    const evidence = {
      kind: "J17_3_LIVE_PREFLIGHT",
      finished_at: new Date().toISOString(),
      gates: {
        FUNDING_CONFIRMED: "PASS",
        PENDING_CONFLICT_SAFE: "PASS",
        GAS_ESTIMATION_FAIL_CLOSED: "PASS",
        ATTESTOR_KEY_VERIFIED: "PASS",
        ONE_TRANSFER_BOUNDARY: "PASS",
        POLICY_STATE_VERIFIED: "PASS",
        JOURNAL_AND_REPLAY_SAFE: "PASS",
        MAINNET_AUTONOMY_READY: "NO-GO",
      },
    };
    const r = requireLivePreflightForExecution({ evidence });
    assert.equal(r.ok, true);
  });

  it("cleanup method is remove_trusted_quote_signer with separate auth", () => {
    assert.equal(ATTESTOR_REVOCATION_PLAN.method, "remove_trusted_quote_signer");
    assert.equal(ATTESTOR_REVOCATION_PLAN.auth_env, AUTH_QUOTE_SIGNER_REVOKE);
    assert.equal(requireQuoteSignerRevokeAuth({}).ok, false);
    assert.equal(
      requireQuoteSignerRevokeAuth({ [AUTH_QUOTE_SIGNER_REVOKE]: "1" }).ok,
      true
    );
  });
});
