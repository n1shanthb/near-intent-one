/**
 * Quote-level economics extraction for AI / observation (not summary counts only).
 */

function nestedQuote(rowOrResult) {
  return (
    rowOrResult?.quote?.quote ||
    rowOrResult?.bound?.bound ||
    rowOrResult?.quote ||
    rowOrResult
  );
}

/**
 * Build a single quote-level economics object for Researcher/Strategist/Critic/Fitter.
 */
export function extractQuoteEconomics(row) {
  if (!row) return null;
  const q = nestedQuote(row);
  const req = row.request || row.quote?.request || {};
  const src = row.source || {};
  const dst = row.destination || {};
  const amountIn = String(q?.amountIn || req.amount || row.amount_in || "");
  const amountOut = String(q?.amountOut || row.amount_out || "");
  const minOut = String(q?.minAmountOut || "");
  const amountInUsd = q?.amountInUsd != null ? Number(q.amountInUsd) : null;
  const amountOutUsd =
    q?.amountOutUsd != null
      ? Number(q.amountOutUsd)
      : row.amount_out_usd != null
        ? Number(row.amount_out_usd)
        : null;
  const feeUsd =
    amountInUsd != null && amountOutUsd != null
      ? amountInUsd - amountOutUsd
      : null;
  const deadline =
    q?.deadline || row.deadline || row.quote?.deadline || req.deadline || null;
  const quotedAt = row.quote?.quoted_at || row.quoted_at || null;
  const freshness_ms = quotedAt ? Date.now() - Date.parse(quotedAt) : null;

  return {
    route_id: row.id || row.route?.id || null,
    label: row.label || row.route?.label || null,
    status: row.status || null,
    ok: Boolean(row.ok),
    dry: row.dry !== false && row.quote?.dry !== false,
    source_chain: src.chain || row.route?.source_chain || null,
    destination_chain: dst.chain || row.route?.destination_chain || null,
    asset_in_id: src.asset_id || req.originAsset || null,
    asset_out_id: dst.asset_id || req.destinationAsset || null,
    asset_in_symbol: src.symbol || null,
    asset_out_symbol: dst.symbol || null,
    decimals_in: src.decimals ?? null,
    decimals_out: dst.decimals ?? null,
    token_contract_in: src.contract_address || null,
    token_contract_out: dst.contract_address || null,
    correlation_id:
      row.quote?.correlation_id ||
      row.bound?.correlationId ||
      q?.correlationId ||
      null,
    quote_id: row.quote?.correlation_id || q?.correlationId || null,
    amount_in_raw: amountIn || null,
    amount_out_raw: amountOut || null,
    min_amount_out_raw: minOut || null,
    amount_in_usd: Number.isFinite(amountInUsd) ? amountInUsd : null,
    amount_out_usd: Number.isFinite(amountOutUsd) ? amountOutUsd : null,
    fee_usd_estimate: Number.isFinite(feeUsd) ? feeUsd : null,
    refund_fee: q?.refundFee ?? null,
    withdraw_fee: q?.withdrawFee ?? null,
    time_estimate_sec: q?.timeEstimate ?? null,
    deadline,
    quoted_at: quotedAt,
    freshness_ms: Number.isFinite(freshness_ms) ? freshness_ms : null,
    deposit_address: row.quote?.deposit_address || q?.depositAddress || null,
    capital_available: Boolean(row.capital?.ok),
    capital_reason: row.capital?.reason || null,
    inventory_note: row.capital?.ok
      ? "verified_balance_covers_amount"
      : row.capital?.reason || "no_verified_inventory",
    net_economics: {
      retention_usd:
        amountInUsd != null && amountOutUsd != null
          ? amountOutUsd / amountInUsd
          : null,
      fee_usd: Number.isFinite(feeUsd) ? feeUsd : null,
      estimated_gas: "not_in_1click_dry_quote — use attested gas_limit*max_gas_price",
    },
    signing_primitive: row.signing?.primitive || row.signing || null,
    one_click_signature_present: Boolean(
      row.quote?.signature || q?.signature || row.signature
    ),
  };
}

/**
 * Market fixture fragment for Gate J — quote-level, not counts-only.
 */
export function buildLiveQuoteMarketFragment(quoteMatrix) {
  const rows = Array.isArray(quoteMatrix?.matrix)
    ? quoteMatrix.matrix
    : Array.isArray(quoteMatrix?.rows)
      ? quoteMatrix.rows
      : [];
  const quotes = rows
    .filter((r) => r && (r.ok || r.status === "QUOTED"))
    .map(extractQuoteEconomics)
    .filter(Boolean);

  return {
    ok: Boolean(quoteMatrix?.ok),
    dry: true,
    quoted_count: quoteMatrix?.quoted_count ?? quotes.length,
    eligible_count: quoteMatrix?.eligible_count ?? 0,
    proposal: quoteMatrix?.proposal || null,
    quotes,
    top_discovery: quotes
      .filter((q) => q.amount_out_usd != null)
      .sort((a, b) => (b.amount_out_usd || 0) - (a.amount_out_usd || 0))
      .slice(0, 8),
    note: "Dry quote-level economics for AI — not funding authorization; deposit addresses absent until funded quote",
  };
}

/**
 * Prove a decision trace saw raw quote fields (not just live_1click label).
 */
export function assertQuoteLevelConsumed(marketFixture, decisionTrace = {}) {
  const live = marketFixture?.live_1click;
  const quotes = live?.quotes || [];
  const required = [
    "asset_in_id",
    "asset_out_id",
    "amount_in_raw",
    "amount_out_raw",
    "min_amount_out_raw",
    "amount_out_usd",
  ];
  const sample = quotes[0] || null;
  const missing = sample
    ? required.filter((k) => sample[k] == null || sample[k] === "")
    : required;
  return {
    ok: Boolean(sample) && missing.length === 0,
    quotes_present: quotes.length,
    sample_route: sample?.route_id || null,
    sample_fields: sample
      ? Object.fromEntries(required.map((k) => [k, sample[k]]))
      : null,
    missing,
    strategist_choice:
      decisionTrace?.strategist?.proposal?.choice ||
      decisionTrace?.strategist_choice ||
      null,
    no_trade_preserved:
      (decisionTrace?.enforcement?.decision ||
        decisionTrace?.strategist?.proposal?.choice ||
        "NO_TRADE") === "NO_TRADE" ||
      decisionTrace?.may_sign === false,
  };
}
