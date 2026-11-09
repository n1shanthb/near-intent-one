/**
 * Deterministic, explainable decision engine (Gate H3).
 * Observes real quotes + exposure; selects TRADE or NO_TRADE.
 * Does not fabricate profits. Contract remains enforcement boundary.
 */

/**
 * @typedef {object} DecisionInput
 * @property {object} exposure — get_exposure_snapshot
 * @property {object|null} quote — Tidepool quote response
 * @property {object} request — agent quote request
 * @property {object} constraints
 * @property {string} constraints.min_amount_out_floor — absolute floor (string bigint)
 * @property {string} constraints.trade_amount — proposed amount_in
 * @property {boolean} constraints.revoked
 * @property {string} [constraints.strategy_id]
 */

/**
 * Implied out/in as rational comparison without floats when possible.
 * Returns true if minOut/amountIn >= minRateNum/minRateDen (approximate via cross multiply).
 */
function rateAtLeast(minOut, amountIn, minRateNum, minRateDen) {
  try {
    const o = BigInt(minOut);
    const a = BigInt(amountIn);
    if (a === 0n) return false;
    // o/a >= num/den  <=>  o*den >= a*num
    return o * BigInt(minRateDen) >= a * BigInt(minRateNum);
  } catch {
    return false;
  }
}

/**
 * @param {DecisionInput} input
 */
export function decide(input) {
  const ts = new Date().toISOString();
  const strategy_id = input.constraints?.strategy_id || "origin-usdc-to-wnear-v1";
  const amount = String(input.constraints.trade_amount);
  const checks = [];
  const reject = (code, detail) => ({
    choice: "NO_TRADE",
    strategy_id,
    timestamp: ts,
    amount_in: amount,
    rationale: detail,
    rejection_code: code,
    checks,
    quote_summary: summarizeQuote(input.quote),
    exposure: input.exposure,
    constraints: input.constraints,
  });

  if (input.constraints.revoked || input.exposure?.revoked || input.exposure?.signing_revoked) {
    checks.push({ ok: false, name: "mandate_active" });
    return reject("MANDATE_REVOKED", "Signing mandate revoked; refuse new trade.");
  }
  checks.push({ ok: true, name: "mandate_active" });

  const reserved = BigInt(input.exposure?.reserved_pending_exposure || "0");
  const maxPending = BigInt(input.constraints.max_pending_exposure || "100000000");
  const tradeAmt = BigInt(amount);
  if (reserved + tradeAmt > maxPending) {
    checks.push({
      ok: false,
      name: "risk_capacity",
      reserved: reserved.toString(),
      trade: amount,
      max: maxPending.toString(),
    });
    return reject(
      "RISK_CAPACITY",
      `reserved(${reserved})+trade(${amount}) exceeds max_pending_exposure(${maxPending})`
    );
  }
  checks.push({ ok: true, name: "risk_capacity", headroom: (maxPending - reserved).toString() });

  if (!input.quote?.quote?.depositAddress || !input.quote?.quote?.minAmountOut) {
    checks.push({ ok: false, name: "quote_present" });
    return reject("NO_QUOTE", "Missing Tidepool quote depositAddress/minAmountOut.");
  }
  checks.push({ ok: true, name: "quote_present" });

  const qAmount = String(input.quote.quote.amountIn || "");
  if (qAmount && qAmount !== amount) {
    checks.push({ ok: false, name: "amount_match", quote: qAmount, want: amount });
    return reject("AMOUNT_MISMATCH", `Quote amountIn ${qAmount} != requested ${amount}`);
  }
  checks.push({ ok: true, name: "amount_match" });

  const minOut = String(input.quote.quote.minAmountOut);
  const floor = String(input.constraints.min_amount_out_floor || "0");
  if (BigInt(minOut) < BigInt(floor)) {
    checks.push({ ok: false, name: "min_out_floor", minOut, floor });
    return reject(
      "MIN_OUT_FLOOR",
      `minAmountOut ${minOut} below floor ${floor}`
    );
  }
  checks.push({ ok: true, name: "min_out_floor", minOut, floor });

  // Soft rate gate: require minOut >= amount * 1e20 (USDC 6dec → wNEAR 24dec rough band).
  // 1 USDC (~1e6) → expect >> 1e20 wNEAR raw units on testnet; floor is configurable.
  const minRateNum = BigInt(input.constraints.min_rate_num || "1");
  const minRateDen = BigInt(input.constraints.min_rate_den || "1");
  // Default: just require minOut > 0 which floor already covered; optional relative rate:
  if (input.constraints.enforce_relative_rate) {
    const okRate = rateAtLeast(minOut, amount, minRateNum, minRateDen);
    checks.push({ ok: okRate, name: "relative_rate", minOut, amount, minRateNum: minRateNum.toString(), minRateDen: minRateDen.toString() });
    if (!okRate) {
      return reject("RATE_TOO_LOW", `Implied minOut/amountIn below configured rate gate`);
    }
  } else {
    checks.push({ ok: true, name: "relative_rate", skipped: true });
  }

  if (input.quote.quote.deadline) {
    const deadlineMs = Date.parse(input.quote.quote.deadline);
    if (Number.isFinite(deadlineMs) && deadlineMs < Date.now() + 60_000) {
      checks.push({ ok: false, name: "quote_ttl" });
      return reject("QUOTE_TTL", "Quote deadline too soon (<60s).");
    }
  }
  checks.push({ ok: true, name: "quote_ttl" });

  return {
    choice: "TRADE",
    strategy_id,
    timestamp: ts,
    amount_in: amount,
    rationale: `Quote viable: minOut=${minOut}, capacity ok, mandate active. Proceed via attestor→policy→MPC.`,
    rejection_code: null,
    checks,
    quote_summary: summarizeQuote(input.quote),
    exposure: input.exposure,
    constraints: input.constraints,
    deposit_address: input.quote.quote.depositAddress,
    min_amount_out: minOut,
    correlation_id: input.quote.correlationId || null,
  };
}

function summarizeQuote(q) {
  if (!q?.quote) return null;
  return {
    correlationId: q.correlationId || null,
    depositAddress: q.quote.depositAddress,
    amountIn: q.quote.amountIn,
    minAmountOut: q.quote.minAmountOut,
    deadline: q.quote.deadline || null,
  };
}
