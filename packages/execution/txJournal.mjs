/**
 * Durable signed-tx journal for future funded execution (P1).
 * Uses node:sqlite with FULL synchronous + WAL. Never treats SIGNED as SUCCESS.
 *
 * States: DRAFT → SIGNED → BROADCAST_PENDING → BROADCAST → CONFIRMED | FAILED | REFUNDED | EXPIRED | REVOKED_AFTER_SIGN
 * Recovery never re-signs; may re-broadcast identical signed bytes only from SIGNED/BROADCAST_PENDING.
 */
import { DatabaseSync } from "node:sqlite";
import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const TX_STATE = Object.freeze({
  DRAFT: "DRAFT",
  SIGNED: "SIGNED",
  BROADCAST_PENDING: "BROADCAST_PENDING",
  BROADCAST: "BROADCAST",
  CONFIRMED: "CONFIRMED",
  SETTLEMENT_PENDING: "SETTLEMENT_PENDING",
  REFUND_PENDING: "REFUND_PENDING",
  SETTLED: "SETTLED",
  RECONCILED: "RECONCILED",
  FAILED: "FAILED",
  REFUNDED: "REFUNDED",
  EXPIRED: "EXPIRED",
  UNKNOWN: "UNKNOWN",
  REVOKED_AFTER_SIGN: "REVOKED_AFTER_SIGN",
});

const TERMINAL = new Set([
  TX_STATE.RECONCILED,
  TX_STATE.FAILED,
  TX_STATE.REFUNDED,
  TX_STATE.EXPIRED,
]);

function assertTransition(from, to) {
  const allowed = {
    [TX_STATE.DRAFT]: [TX_STATE.SIGNED, TX_STATE.FAILED, TX_STATE.EXPIRED, TX_STATE.REVOKED_AFTER_SIGN],
    [TX_STATE.SIGNED]: [
      TX_STATE.BROADCAST_PENDING,
      TX_STATE.EXPIRED,
      TX_STATE.REVOKED_AFTER_SIGN,
      TX_STATE.FAILED,
    ],
    [TX_STATE.BROADCAST_PENDING]: [
      TX_STATE.BROADCAST,
      TX_STATE.SIGNED, // rollback if send never accepted
      TX_STATE.FAILED,
      TX_STATE.UNKNOWN,
    ],
    [TX_STATE.BROADCAST]: [
      TX_STATE.CONFIRMED,
      TX_STATE.FAILED,
      TX_STATE.REFUND_PENDING,
      TX_STATE.REFUNDED,
      TX_STATE.BROADCAST,
      TX_STATE.SIGNED,
      TX_STATE.UNKNOWN,
    ],
    [TX_STATE.CONFIRMED]: [
      TX_STATE.SETTLEMENT_PENDING,
      TX_STATE.REFUND_PENDING,
      TX_STATE.FAILED,
    ],
    [TX_STATE.SETTLEMENT_PENDING]: [
      TX_STATE.SETTLED,
      TX_STATE.REFUND_PENDING,
      TX_STATE.REFUNDED,
      TX_STATE.FAILED,
      TX_STATE.UNKNOWN,
    ],
    [TX_STATE.REFUND_PENDING]: [TX_STATE.REFUNDED, TX_STATE.FAILED, TX_STATE.UNKNOWN],
    [TX_STATE.SETTLED]: [TX_STATE.RECONCILED, TX_STATE.FAILED],
    [TX_STATE.RECONCILED]: [],
    [TX_STATE.FAILED]: [],
    [TX_STATE.REFUNDED]: [],
    [TX_STATE.EXPIRED]: [],
    [TX_STATE.UNKNOWN]: [
      TX_STATE.BROADCAST,
      TX_STATE.CONFIRMED,
      TX_STATE.FAILED,
      TX_STATE.REFUNDED,
      TX_STATE.SIGNED,
    ],
    [TX_STATE.REVOKED_AFTER_SIGN]: [], // residual: bytes may still land on chain
  };
  if (!(allowed[from] || []).includes(to) && from !== to) {
    throw new Error(`invalid_transition:${from}->${to}`);
  }
}

function encryptBlob(plaintext, key32) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key32, iv);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decryptBlob(b64, key32) {
  const buf = Buffer.from(b64, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key32, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export function deriveJournalKey(secret) {
  return createHash("sha256").update(String(secret || "nio-journal-dev")).digest();
}

export function localTxHash(signedRawHex) {
  const raw = Buffer.from(String(signedRawHex).replace(/^0x/, ""), "hex");
  // keccak not required for journal identity — sha256 of bytes is fine for idempotency key
  return createHash("sha256").update(raw).digest("hex");
}

export function openTxJournal({ path, secret }) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = FULL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tx_journal (
      id TEXT PRIMARY KEY,
      portfolio_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL,
      nonce TEXT,
      chain_id TEXT,
      quote_deadline_ms INTEGER,
      signed_raw_enc TEXT,
      local_tx_hash TEXT,
      broadcast_hash TEXT,
      receipt_json TEXT,
      meta_json TEXT,
      claim_owner TEXT,
      claim_until INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  try {
    db.exec("ALTER TABLE tx_journal ADD COLUMN claim_owner TEXT;");
  } catch {
    /* exists */
  }
  try {
    db.exec("ALTER TABLE tx_journal ADD COLUMN claim_until INTEGER;");
  } catch {
    /* exists */
  }
  const key32 = deriveJournalKey(secret);

  function assertWritable() {
    const probe = db.prepare("SELECT 1 AS ok").get();
    if (!probe || probe.ok !== 1) throw new Error("journal_unreadable");
    const now = new Date().toISOString();
    db.prepare(
      `INSERT OR REPLACE INTO tx_journal
      (id, portfolio_id, idempotency_key, state, meta_json, created_at, updated_at)
      VALUES ('__health__', '_', '__health__', ?, '{}', ?, ?)`
    ).run(TX_STATE.FAILED, now, now);
    db.prepare("DELETE FROM tx_journal WHERE id = '__health__'").run();
    return true;
  }

  function get(id) {
    const row = db.prepare("SELECT * FROM tx_journal WHERE id = ?").get(id);
    return row || null;
  }

  function getByIdempotency(idempotencyKey) {
    return (
      db.prepare("SELECT * FROM tx_journal WHERE idempotency_key = ?").get(idempotencyKey) ||
      null
    );
  }

  function insertDraft(row) {
    const existing = getByIdempotency(row.idempotency_key);
    if (existing) return { ok: true, idempotent: true, record: existing };
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO tx_journal
      (id, portfolio_id, idempotency_key, state, nonce, chain_id, quote_deadline_ms,
       signed_raw_enc, local_tx_hash, broadcast_hash, receipt_json, meta_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`
    ).run(
      row.id,
      row.portfolio_id,
      row.idempotency_key,
      TX_STATE.DRAFT,
      row.nonce || null,
      row.chain_id || null,
      row.quote_deadline_ms || null,
      JSON.stringify(row.meta || {}),
      now,
      now
    );
    return { ok: true, idempotent: false, record: get(row.id) };
  }

  function transition(id, to, patch = {}) {
    const cur = get(id);
    if (!cur) throw new Error("unknown_journal_id");
    assertTransition(cur.state, to);
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE tx_journal SET
        state = ?,
        signed_raw_enc = COALESCE(?, signed_raw_enc),
        local_tx_hash = COALESCE(?, local_tx_hash),
        broadcast_hash = COALESCE(?, broadcast_hash),
        receipt_json = COALESCE(?, receipt_json),
        meta_json = COALESCE(?, meta_json),
        updated_at = ?
      WHERE id = ?`
    ).run(
      to,
      patch.signed_raw_enc ?? null,
      patch.local_tx_hash ?? null,
      patch.broadcast_hash ?? null,
      patch.receipt_json ?? null,
      patch.meta_json ?? null,
      now,
      id
    );
    return get(id);
  }

  /** Persist signed bytes BEFORE any broadcast attempt. */
  function markSigned(id, { signedRawHex, meta } = {}) {
    if (!signedRawHex) throw new Error("signed_raw_required");
    const hash = localTxHash(signedRawHex);
    const enc = encryptBlob(Buffer.from(String(signedRawHex).replace(/^0x/, ""), "hex"), key32);
    return transition(id, TX_STATE.SIGNED, {
      signed_raw_enc: enc,
      local_tx_hash: hash,
      meta_json: meta ? JSON.stringify(meta) : null,
    });
  }

  function beginBroadcast(id) {
    return transition(id, TX_STATE.BROADCAST_PENDING);
  }

  function markBroadcast(id, broadcastHash) {
    if (!broadcastHash) throw new Error("broadcast_hash_required");
    return transition(id, TX_STATE.BROADCAST, { broadcast_hash: broadcastHash });
  }

  function markConfirmed(id, receipt) {
    if (!receipt || receipt.independently_verified !== true) {
      throw new Error("confirmed_requires_independent_receipt");
    }
    const st = receipt.status;
    if (st === "0x0" || st === 0 || st === "0") {
      return transition(id, TX_STATE.FAILED, {
        receipt_json: JSON.stringify(receipt),
      });
    }
    if (st !== "0x1" && st !== 1 && st !== "1") {
      throw new Error("confirmed_requires_success_receipt_status");
    }
    return transition(id, TX_STATE.CONFIRMED, {
      receipt_json: JSON.stringify(receipt),
    });
  }

  function markSettlementPending(id, detail) {
    return transition(id, TX_STATE.SETTLEMENT_PENDING, {
      receipt_json: detail ? JSON.stringify(detail) : null,
    });
  }

  function markSettled(id, detail) {
    return transition(id, TX_STATE.SETTLED, {
      receipt_json: JSON.stringify(detail || {}),
    });
  }

  function markReconciled(id, detail) {
    return transition(id, TX_STATE.RECONCILED, {
      receipt_json: JSON.stringify(detail || {}),
    });
  }

  function markRefundPending(id, detail) {
    return transition(id, TX_STATE.REFUND_PENDING, {
      receipt_json: detail ? JSON.stringify(detail) : null,
    });
  }

  function markUnknown(id, detail) {
    return transition(id, TX_STATE.UNKNOWN, {
      meta_json: JSON.stringify({ ...(detail || {}), unknown_at: new Date().toISOString() }),
    });
  }

  /**
   * Exclusive claim so two workers cannot advance the same op.
   * @returns {{ ok: true, record } | { ok: false, reason }}
   */
  function tryClaim(id, workerId, ttlMs = 60_000) {
    const cur = get(id);
    if (!cur) return { ok: false, reason: "unknown_journal_id" };
    const now = Date.now();
    if (
      cur.claim_owner &&
      cur.claim_owner !== workerId &&
      Number(cur.claim_until || 0) > now
    ) {
      return { ok: false, reason: "claimed_by_other", claim_owner: cur.claim_owner };
    }
    db.prepare(
      `UPDATE tx_journal SET claim_owner = ?, claim_until = ?, updated_at = ? WHERE id = ?`
    ).run(workerId, now + ttlMs, new Date().toISOString(), id);
    const next = get(id);
    if (next.claim_owner !== workerId) {
      return { ok: false, reason: "claim_race_lost" };
    }
    return { ok: true, record: next };
  }

  function releaseClaim(id, workerId) {
    const cur = get(id);
    if (!cur) return;
    if (cur.claim_owner && cur.claim_owner !== workerId) return;
    db.prepare(
      `UPDATE tx_journal SET claim_owner = NULL, claim_until = NULL, updated_at = ? WHERE id = ?`
    ).run(new Date().toISOString(), id);
  }

  function markFailed(id, reason) {
    const cur = get(id);
    if (!cur) throw new Error("unknown_journal_id");
    if (TERMINAL.has(cur.state) && cur.state !== TX_STATE.FAILED) {
      throw new Error(`already_terminal:${cur.state}`);
    }
    return transition(id, TX_STATE.FAILED, {
      meta_json: JSON.stringify({ ...(JSON.parse(cur.meta_json || "{}")), fail_reason: reason }),
    });
  }

  function markRefunded(id, detail) {
    return transition(id, TX_STATE.REFUNDED, {
      receipt_json: JSON.stringify(detail || {}),
    });
  }

  function markExpired(id) {
    const cur = get(id);
    if (!cur) throw new Error("unknown_journal_id");
    if (TERMINAL.has(cur.state)) return cur;
    return transition(id, TX_STATE.EXPIRED);
  }

  function markRevokedAfterSign(id) {
    const cur = get(id);
    if (!cur) throw new Error("unknown_journal_id");
    if (cur.state === TX_STATE.DRAFT) {
      return transition(id, TX_STATE.REVOKED_AFTER_SIGN);
    }
    if (cur.state === TX_STATE.SIGNED || cur.state === TX_STATE.BROADCAST_PENDING) {
      // Bytes may still broadcast — record residual risk state.
      return transition(id, TX_STATE.REVOKED_AFTER_SIGN);
    }
    throw new Error(`revoke_after_sign_invalid:${cur.state}`);
  }

  /** Decrypt signed bytes for identical rebroadcast only. Never invents new signature. */
  function loadSignedRaw(id) {
    const cur = get(id);
    if (!cur?.signed_raw_enc) return null;
    if (
      ![
        TX_STATE.SIGNED,
        TX_STATE.BROADCAST_PENDING,
        TX_STATE.BROADCAST,
        TX_STATE.UNKNOWN,
        TX_STATE.REVOKED_AFTER_SIGN,
      ].includes(cur.state)
    ) {
      return null;
    }
    const raw = decryptBlob(cur.signed_raw_enc, key32);
    return `0x${raw.toString("hex")}`;
  }

  function recoverOnRestart() {
    const rows = db
      .prepare(
        `SELECT * FROM tx_journal WHERE state IN (?, ?, ?) ORDER BY updated_at ASC`
      )
      .all(TX_STATE.SIGNED, TX_STATE.BROADCAST_PENDING, TX_STATE.BROADCAST);
    return rows.map((r) => ({
      id: r.id,
      state: r.state,
      portfolio_id: r.portfolio_id,
      local_tx_hash: r.local_tx_hash,
      broadcast_hash: r.broadcast_hash,
      may_resign: false,
      may_rebroadcast_identical:
        r.state === TX_STATE.SIGNED || r.state === TX_STATE.BROADCAST_PENDING,
      note:
        r.state === TX_STATE.BROADCAST
          ? "await_confirmation_or_reorg_check"
          : "identical_bytes_only",
    }));
  }

  function applyReorg(id, { stillIncluded }) {
    const cur = get(id);
    if (!cur || cur.state !== TX_STATE.BROADCAST && cur.state !== TX_STATE.CONFIRMED) {
      throw new Error("reorg_requires_broadcast_or_confirmed");
    }
    if (stillIncluded) {
      if (cur.state === TX_STATE.CONFIRMED) return cur;
      return transition(id, TX_STATE.BROADCAST);
    }
    // Dropped by reorg — back to signed for identical rebroadcast decision.
    if (cur.state === TX_STATE.CONFIRMED) {
      // Downgrade carefully: treat as broadcast lost
      db.prepare(`UPDATE tx_journal SET state = ?, updated_at = ? WHERE id = ?`).run(
        TX_STATE.SIGNED,
        new Date().toISOString(),
        id
      );
      return get(id);
    }
    return transition(id, TX_STATE.SIGNED);
  }

  function close() {
    db.close();
  }

  return {
    db,
    get,
    getByIdempotency,
    insertDraft,
    markSigned,
    beginBroadcast,
    markBroadcast,
    markConfirmed,
    markSettlementPending,
    markSettled,
    markReconciled,
    markRefundPending,
    markUnknown,
    markFailed,
    markRefunded,
    markExpired,
    markRevokedAfterSign,
    loadSignedRaw,
    recoverOnRestart,
    applyReorg,
    tryClaim,
    releaseClaim,
    assertWritable,
    close,
    TX_STATE,
  };
}
