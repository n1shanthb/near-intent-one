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

  let raw;
  try {
    raw = await quoteFn({
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

  // Normalize Tidepool /v0/quote envelope + flat fixtures
  const inner = raw?.quote && typeof raw.quote === "object" ? raw.quote : raw;
  const amount_out =
    inner?.amount_out ||
    inner?.amountOut ||
    inner?.minAmountOut ||
    raw?.amount_out ||
    raw?.amountOut;
  const quote_hash =
    raw?.quote_hash ||
    raw?.quoteHash ||
    inner?.quote_hash ||
    raw?.correlationId ||
    null;
  const deposit_address =
    inner?.depositAddress || inner?.deposit_address || raw?.depositAddress;
  const deadline =
    inner?.deadline || raw?.deadline || raw?.quoteRequest?.deadline;

  if (!raw || !amount_out) {
    return {
      ok: false,
      reason: REASON.NO_FRESH_QUOTE,
      detail: "missing_amount_out",
      quote: raw,
    };
  }

  const now = Date.now();
  const expiresAt = deadline
    ? Date.parse(deadline)
    : raw.expires_at_ms || raw.deadline_ms || now + deadlineMs;
  if (!Number.isFinite(expiresAt) || expiresAt <= now + 5_000) {
    return {
      ok: false,
      reason: REASON.NO_FRESH_QUOTE,
      detail: "quote_near_expiry",
      quote: raw,
    };
  }

  return {
    ok: true,
    quote: {
      ...raw,
      quote_hash: quote_hash || `tidepool:${raw.correlationId || now}`,
      amount_out: String(amount_out),
      deposit_address,
      origin_asset: ORIGIN_ASSET,
      destination_asset: DEST_ASSET,
      amount_in: amount,
      fetched_at_ms: now,
      expires_at_ms: expiresAt,
    },
  };
}
