/**
 * Gate I4 — financial units / valuation (fail closed).
 * Raw token amounts are NEVER compared across assets as if they were USD.
 */

/** Supported testnet pairs with explicit decimals and optional static USD estimate. */
export const ASSET_META = {
  "nep141:eth-0x2e6ad9e6d59bb4585ea0e6762c3b637dde29dad2.tp-omft.testnet": {
    symbol: "USDC",
    decimals: 6,
    chain: "sepolia+intents",
    /** Static testnet estimate only — not a live oracle. */
    usd_per_unit: 1.0,
    pricing: "static_testnet_estimate",
  },
  "nep141:wnear.tidepool-sandbox.testnet": {
    symbol: "wNEAR",
    decimals: 24,
    chain: "intents",
    /** Fail closed unless caller supplies a quote-implied rate. */
    usd_per_unit: null,
    pricing: "quote_implied_only",
  },
  "USDC": {
    symbol: "USDC",
    decimals: 6,
    chain: "policy-alias",
    usd_per_unit: 1.0,
    pricing: "static_testnet_estimate",
  },
  "NEAR": {
    symbol: "NEAR",
    decimals: 24,
    chain: "near",
    usd_per_unit: null,
    pricing: "quote_implied_only",
  },
};

export function getAssetMeta(assetId) {
  return ASSET_META[assetId] || null;
}

/**
 * Convert raw integer amount to decimal string without float drift for display.
 */
export function formatRaw(amountRaw, decimals) {
  const s = BigInt(amountRaw).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals) || "0";
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * USD estimate for limit checks. Fail closed if pricing missing.
 * @returns {{ ok: true, usdEstimate: number, raw: string, decimals: number, symbol: string } | { ok: false, reason: string }}
 */
export function estimateUsd({ assetId, amountRaw, quoteImpliedUsdPerUnit = null }) {
  const meta = getAssetMeta(assetId);
  if (!meta) {
    return { ok: false, reason: `unknown_asset:${assetId}` };
  }
  let px = meta.usd_per_unit;
  if (px == null) {
    if (quoteImpliedUsdPerUnit == null || !(quoteImpliedUsdPerUnit > 0)) {
      return {
        ok: false,
        reason: `missing_pricing:${meta.symbol}:supply_quote_implied_usd_or_restrict_pair`,
      };
    }
    px = quoteImpliedUsdPerUnit;
  }
  const raw = BigInt(amountRaw);
  const scale = 10n ** BigInt(meta.decimals);
  // usd = raw/scale * px  → use Number only after dividing to a reasonable range
  const whole = Number(raw / scale);
  const frac = Number(raw % scale) / Number(scale);
  const usdEstimate = (whole + frac) * px;
  if (!Number.isFinite(usdEstimate)) {
    return { ok: false, reason: "non_finite_usd_estimate" };
  }
  return {
    ok: true,
    usdEstimate,
    raw: raw.toString(),
    decimals: meta.decimals,
    symbol: meta.symbol,
    pricing: meta.usd_per_unit != null ? meta.pricing : "quote_implied",
  };
}

/**
 * Compare trade against policy max_trade_value interpreted as **USD micro-units**
 * (1e6 = $1) when asset is USDC; otherwise require explicit usd estimate.
 */
export function checkTradeWithinUsdLimit({
  assetIn,
  amountInRaw,
  maxTradeValueRaw,
  maxTradeValueUnit = "usdc_base_units",
  quoteImpliedUsdPerUnit = null,
}) {
  const est = estimateUsd({
    assetId: assetIn,
    amountRaw: amountInRaw,
    quoteImpliedUsdPerUnit,
  });
  if (!est.ok) return { ok: false, ...est };

  let limitUsd;
  if (maxTradeValueUnit === "usdc_base_units") {
    limitUsd = Number(BigInt(maxTradeValueRaw)) / 1e6;
  } else if (maxTradeValueUnit === "usd") {
    limitUsd = Number(maxTradeValueRaw);
  } else {
    return { ok: false, reason: `unknown_limit_unit:${maxTradeValueUnit}` };
  }

  if (!(limitUsd >= 0) || !Number.isFinite(limitUsd)) {
    return { ok: false, reason: "invalid_limit" };
  }
  if (est.usdEstimate > limitUsd) {
    return {
      ok: false,
      reason: "exceeds_max_trade_value_usd",
      usdEstimate: est.usdEstimate,
      limitUsd,
      asset: est.symbol,
      raw: est.raw,
    };
  }
  return {
    ok: true,
    usdEstimate: est.usdEstimate,
    limitUsd,
    asset: est.symbol,
    raw: est.raw,
    decimals: est.decimals,
    pricing: est.pricing,
  };
}

/** Buckets for reporting — never mix into one “P/L” number without labels. */
export function emptyLedgerBuckets() {
  return {
    raw_balances: {},
    usd_estimates: {},
    pending_exposure_raw: "0",
    pending_exposure_usd: null,
    realized_spend_raw: "0",
    realized_spend_usd: null,
    network_fees: { near_yocto: null, sepolia_wei: null },
    historical_performance: { note: "not_fabricated; populate from verified settlements only" },
  };
}
