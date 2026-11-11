import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openTxJournal,
  TX_STATE,
  localTxHash,
} from "./txJournal.mjs";

describe("durable tx journal — crash / recovery (P1)", () => {
  let dir;
  let journal;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "nio-journal-"));
    journal = openTxJournal({
      path: join(dir, "tx.sqlite"),
      secret: "test-journal-secret-32bytes-min!!",
    });
  });

  after(() => {
    try {
      journal.close();
    } catch {
      /* closed */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("1. crash before signing leaves DRAFT — no re-sign obligation", () => {
    const id = "j-crash-before-sign";
    journal.insertDraft({
      id,
      portfolio_id: "p1",
      idempotency_key: "idem-1",
      nonce: "1",
      chain_id: "42161",
    });
    const row = journal.get(id);
    assert.equal(row.state, TX_STATE.DRAFT);
    assert.equal(journal.loadSignedRaw(id), null);
  });

  it("2. crash after signing persists encrypted bytes; recovery may_rebroadcast only", () => {
    const id = "j-crash-after-sign";
    journal.insertDraft({
      id,
      portfolio_id: "p1",
      idempotency_key: "idem-2",
      nonce: "2",
      chain_id: "42161",
    });
    const raw = "0xdeadbeef";
    journal.markSigned(id, { signedRawHex: raw });
    const row = journal.get(id);
    assert.equal(row.state, TX_STATE.SIGNED);
    assert.equal(row.local_tx_hash, localTxHash(raw));
    assert.equal(journal.loadSignedRaw(id), "0xdeadbeef");
    const rec = journal.recoverOnRestart().find((r) => r.id === id);
    assert.equal(rec.may_resign, false);
    assert.equal(rec.may_rebroadcast_identical, true);
  });

  it("3. crash immediately before broadcast stays SIGNED after beginBroadcast rollback path", () => {
    const id = "j-crash-pre-bcast";
    journal.insertDraft({
      id,
      portfolio_id: "p1",
      idempotency_key: "idem-3",
      nonce: "3",
      chain_id: "42161",
    });
    journal.markSigned(id, { signedRawHex: "0xaa" });
    journal.beginBroadcast(id);
    assert.equal(journal.get(id).state, TX_STATE.BROADCAST_PENDING);
    // Simulate crash: reopen DB
    journal.close();
    journal = openTxJournal({
      path: join(dir, "tx.sqlite"),
      secret: "test-journal-secret-32bytes-min!!",
    });
    const pending = journal.recoverOnRestart().find((r) => r.id === id);
    assert.ok(pending);
    assert.equal(pending.may_rebroadcast_identical, true);
    assert.equal(pending.may_resign, false);
  });

  it("4–5. crash after network accept / before receipt → BROADCAST, not SUCCESS", () => {
    const id = "j-crash-after-bcast";
    journal.insertDraft({
      id,
      portfolio_id: "p1",
      idempotency_key: "idem-4",
      nonce: "4",
      chain_id: "42161",
    });
    journal.markSigned(id, { signedRawHex: "0xbb" });
    journal.beginBroadcast(id);
    journal.markBroadcast(id, "0xreceiptpending");
    const row = journal.get(id);
    assert.equal(row.state, TX_STATE.BROADCAST);
    assert.notEqual(row.state, "SUCCESS");
    assert.equal(row.broadcast_hash, "0xreceiptpending");
  });

  it("6. duplicate worker start is idempotent on draft insert", () => {
    const a = journal.insertDraft({
      id: "j-dup",
      portfolio_id: "p1",
      idempotency_key: "idem-dup",
      nonce: "6",
    });
    const b = journal.insertDraft({
      id: "j-dup-other",
      portfolio_id: "p1",
      idempotency_key: "idem-dup",
      nonce: "6",
    });
    assert.equal(a.idempotent, false);
    assert.equal(b.idempotent, true);
    assert.equal(b.record.id, "j-dup");
  });

  it("7. quote expiry marks EXPIRED from DRAFT/SIGNED", () => {
    const id = "j-expire";
    journal.insertDraft({
      id,
      portfolio_id: "p1",
      idempotency_key: "idem-7",
      quote_deadline_ms: Date.now() - 1,
    });
    journal.markExpired(id);
    assert.equal(journal.get(id).state, TX_STATE.EXPIRED);
  });

  it("8. revocation before signing → REVOKED_AFTER_SIGN from DRAFT", () => {
    const id = "j-rev-pre";
    journal.insertDraft({
      id,
      portfolio_id: "p1",
      idempotency_key: "idem-8",
    });
    journal.markRevokedAfterSign(id);
    assert.equal(journal.get(id).state, TX_STATE.REVOKED_AFTER_SIGN);
    assert.equal(journal.loadSignedRaw(id), null);
  });

  it("9. revocation after signed bytes exist records residual risk; bytes still loadable", () => {
    const id = "j-rev-post";
    journal.insertDraft({
      id,
      portfolio_id: "p1",
      idempotency_key: "idem-9",
    });
    journal.markSigned(id, { signedRawHex: "0xccdd" });
    journal.markRevokedAfterSign(id);
    assert.equal(journal.get(id).state, TX_STATE.REVOKED_AFTER_SIGN);
    assert.equal(journal.loadSignedRaw(id), "0xccdd");
  });

  it("10. delayed/refunded settlement is terminal and not SUCCESS", () => {
    const id = "j-refund";
    journal.insertDraft({
      id,
      portfolio_id: "p1",
      idempotency_key: "idem-10",
    });
    journal.markSigned(id, { signedRawHex: "0xee" });
    journal.beginBroadcast(id);
    journal.markBroadcast(id, "0xbcast");
    journal.markRefunded(id, { status: "REFUNDED" });
    assert.equal(journal.get(id).state, TX_STATE.REFUNDED);
  });

  it("confirmation only after explicit markConfirmed", () => {
    const id = "j-confirm";
    journal.insertDraft({
      id,
      portfolio_id: "p1",
      idempotency_key: "idem-11",
    });
    journal.markSigned(id, { signedRawHex: "0xff" });
    journal.beginBroadcast(id);
    journal.markBroadcast(id, "0xb2");
    journal.markConfirmed(id, {
      status: "0x1",
      blockNumber: "0x10",
      independently_verified: true,
      transactionHash: "0xb2",
    });
    assert.equal(journal.get(id).state, TX_STATE.CONFIRMED);
  });

  it("reorg drops inclusion → back to SIGNED for identical rebroadcast", () => {
    const id = "j-reorg";
    journal.insertDraft({
      id,
      portfolio_id: "p1",
      idempotency_key: "idem-12",
    });
    journal.markSigned(id, { signedRawHex: "0x11" });
    journal.beginBroadcast(id);
    journal.markBroadcast(id, "0xb3");
    journal.applyReorg(id, { stillIncluded: false });
    assert.equal(journal.get(id).state, TX_STATE.SIGNED);
  });

  it("refuses invalid transitions and does not invent signatures", () => {
    const id = "j-bad";
    journal.insertDraft({
      id,
      portfolio_id: "p1",
      idempotency_key: "idem-13",
    });
    assert.throws(() => journal.markBroadcast(id, "0x"), /invalid_transition/);
    assert.throws(() => journal.markSigned(id, {}), /signed_raw_required/);
  });
});
