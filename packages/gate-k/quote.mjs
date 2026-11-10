/**
 * Fresh Tidepool quote for Gate K execution path.
 * Reuses agent quote shape; fails closed if no executable quote.
 */
import { ORIGIN_ASSET, DEST_ASSET, REASON } from "./constants.mjs";

export async function fetchFreshExecutableQuote({
  amountRaw,
  deadlineMs = 60_000,
  quoteFn,
}) {
  if (!quoteFn) {
    return { ok: false, reason: REASON.NO_FRESH_QUOTE, detail: "quote_fn_missing" };
  }
  const amount = String(amountRaw);
  if (!amount || amount === "0") {
    return { ok: false, reason: REASON.NO_FRESH_QUOTE, detail: "zero_amount" };
  }

  let quote;
  try {
    quote = await quoteFn({
      originAsset: ORIGIN_ASSET,
      destinationAsset: DEST_ASSET,
      amount,
      deadlineMs,
    });
  } catch (e) {
    return {
      ok: false,
      reason: REASON.NO_FRESH_QUOTE,
      detail: String(e?.message || e),
    };
  }

  if (!quote || !quote.quote_hash || !quote.amount_out) {
    return {
      ok: false,
      reason: REASON.NO_FRESH_QUOTE,
      detail: "missing_hash_or_amount_out",
      quote,
    };
  }

  const now = Date.now();
  const expiresAt = quote.expires_at_ms || quote.deadline_ms || now + deadlineMs;
  if (expiresAt <= now + 5_000) {
    return { ok: false, reason: REASON.NO_FRESH_QUOTE, detail: "quote_near_expiry", quote };
  }

  return {
    ok: true,
    quote: {
      ...quote,
      origin_asset: ORIGIN_ASSET,
      destination_asset: DEST_ASSET,
      amount_in: amount,
      fetched_at_ms: now,
      expires_at_ms: expiresAt,
    },
  };
}
