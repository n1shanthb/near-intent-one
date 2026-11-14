/**
 * OCI Node20 stub — full journal requires node:sqlite (Node 22+).
 * Decision-only / SHADOW autonomous cycles work without durable TX journal.
 * MAINNET TRADE settlement that needs journal will fail closed here.
 */
export const TX_STATE = Object.freeze({
  DRAFT: "DRAFT",
  SIGNED: "SIGNED",
  BROADCAST_PENDING: "BROADCAST_PENDING",
  BROADCAST: "BROADCAST",
  CONFIRMED: "CONFIRMED",
  FAILED: "FAILED",
  REFUNDED: "REFUNDED",
  EXPIRED: "EXPIRED",
  UNKNOWN: "UNKNOWN",
  REVOKED_AFTER_SIGN: "REVOKED_AFTER_SIGN",
  SETTLEMENT_PENDING: "SETTLEMENT_PENDING",
  REFUND_PENDING: "REFUND_PENDING",
  SETTLED: "SETTLED",
  RECONCILED: "RECONCILED",
});

export function localTxHash(rawHex) {
  return `stub_${String(rawHex || "").slice(0, 16)}`;
}

export function openTxJournal() {
  const err = () => {
    throw new Error("tx_journal_unavailable_on_oci_node20");
  };
  return {
    assertWritable: err,
    get: () => null,
    list: () => [],
    insert: err,
    update: err,
    close: () => {},
  };
}
