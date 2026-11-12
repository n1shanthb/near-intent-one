/**
 * Multichain AI route selection over live 1Click dry quotes.
 * Never invents balances. Never enables funded execution.
 * Selection is economic + mandate-aware — not largest amountOut alone.
 */
import { ROUTE_STATUS } from "../execution/router.mjs";
import { productionDryQuote } from "./intents.mjs";
import { requiredSigningPrimitive } from "./intents.mjs";
import {
  bindQuoteToRequest,
  validateQuoteRequest,
  validateRecipientRefund,
} from "./intents.production.mjs";
import {
  fetchFourChainCatalog,
  resolveCanonicalAssets,
  NIO_CHAINS,
} from "./tokenCatalog.mjs";

/** Four-chain route universe — not Arbitrum-only. Discovery ≠ funded readiness. */
function buildFourChainDemoRoutes() {
  const usdcSources = [
    { chain: "ethereum", key: "eth_usdc", label: "Ethereum USDC" },
    { chain: "arbitrum", key: "arb_usdc", label: "Arbitrum USDC" },
    { chain: "base", key: "base_usdc", label: "Base USDC" },
  ];
  const usdcDests = [
    { chain: "ethereum", key: "eth_usdc", label: "Ethereum USDC" },
    { chain: "arbitrum", key: "arb_usdc", label: "Arbitrum USDC" },
    { chain: "base", key: "base_usdc", label: "Base USDC" },
    { chain: "near", key: "wrap_near", label: "NEAR wNEAR" },
    { chain: "near", key: "near_usdc", label: "NEAR USDC" },
  ];
  const routes = [];
  for (const src of usdcSources) {
    for (const dst of usdcDests) {
      if (src.key === dst.key) continue;
      routes.push({
        id: `${src.key}_to_${dst.key}`,
        source_chain: src.chain,
        destination_chain: dst.chain,
        source_key: src.key,
        dest_key: dst.key,
        label: `${src.label} → ${dst.label}`,
      });
    }
  }
  // NEAR-origin discovery rows (signing may_use=false until NEP-141 path exists)
  for (const dst of [
    { chain: "ethereum", key: "eth_usdc", label: "Ethereum USDC" },
    { chain: "arbitrum", key: "arb_usdc", label: "Arbitrum USDC" },
    { chain: "base", key: "base_usdc", label: "Base USDC" },
  ]) {
    routes.push({
      id: `near_usdc_to_${dst.key}`,
      source_chain: "near",
      destination_chain: dst.chain,
      source_key: "near_usdc",
      dest_key: dst.key,
      label: `NEAR USDC → ${dst.label}`,
    });
    routes.push({
      id: `wrap_near_to_${dst.key}`,
      source_chain: "near",
      destination_chain: dst.chain,
      source_key: "wrap_near",
      dest_key: dst.key,
      label: `NEAR wNEAR → ${dst.label}`,
    });
  }
  return Object.freeze(routes);
}

export const DEMO_ROUTES = buildFourChainDemoRoutes();

/**
 * @param {object} balances — map asset_id → { amount_raw, verified: boolean, chain }
 * Fictional balances are rejected (verified must be true for capital use).
 */
export function capitalAvailable(balances, assetId, amountRaw) {
  const b = balances?.[assetId];
  if (!b) {
    return {
      ok: false,
      reason: "no_balance_entry",
      asset_id: assetId,
    };
  }
  if (b.verified !== true) {
    return {
      ok: false,
      reason: "balance_not_verified_on_chain",
      asset_id: assetId,
      note: "Refuse fictional / claimed balances for trade selection",
    };
  }
  let have;
  let need;
  try {
    have = BigInt(String(b.amount_raw || "0"));
    need = BigInt(String(amountRaw));
  } catch {
    return { ok: false, reason: "balance_parse_error" };
  }
  if (need <= 0n) return { ok: false, reason: "bad_amount" };
  if (have < need) {
    return {
      ok: false,
      reason: "insufficient_verified_balance",
      have: have.toString(),
      need: need.toString(),
    };
  }
  return { ok: true, have: have.toString(), need: need.toString() };
}

function usdOut(quote) {
  const q = quote?.quote || quote;
  const usd = Number(q?.amountOutUsd ?? q?.amount_out_usd);
  if (Number.isFinite(usd) && usd > 0) return usd;
  return null;
}

function feeUsdEstimate(quote, amountInUsd) {
  const q = quote?.quote || quote;
  const outUsd = usdOut(quote);
  const inUsd =
    Number(q?.amountInUsd ?? amountInUsd) ||
    (Number.isFinite(amountInUsd) ? amountInUsd : null);
  if (inUsd != null && outUsd != null) {
    return Math.max(0, inUsd - outUsd);
  }
  return null;
}

/**
 * Fitter-style score: net USD retention after fees/slippage proxy, mandate checks.
 * Critic may veto separately. Largest raw amountOut alone is never sufficient.
 */
export function scoreCandidate({
  quote,
  capital,
  mandate = {},
  signing,
  route,
}) {
  const checks = [];
  const fail = (reason) => {
    checks.push({ ok: false, reason });
    return { ok: false, score: -Infinity, decision: "REJECT", checks, reason };
  };

  if (!quote?.ok) return fail(quote?.reason || "quote_failed");
  if (!capital?.ok) return fail(capital.reason || "no_capital");
  if (mandate.paused) return fail("mandate_paused");
  if (mandate.revoked) return fail("mandate_revoked");
  if (signing && signing.may_use === false) {
    checks.push({
      ok: false,
      reason: "signing_primitive_not_ready",
      detail: signing,
    });
    // Still score for discovery, but mark not executable
  }

  const q = quote.quote || {};
  const outUsd = usdOut(quote);
  const inUsd = Number(q.amountInUsd);
  const feeUsd = feeUsdEstimate(quote, inUsd);
  const slipBps = Number(mandate.max_slippage_bps ?? 50);
  const quoteSlip =
    q.minAmountOut && q.amountOut
      ? Number(
          ((BigInt(q.amountOut) - BigInt(q.minAmountOut)) * 10000n) /
            BigInt(q.amountOut)
        )
      : null;

  if (outUsd == null || !Number.isFinite(outUsd)) {
    return fail("missing_amount_out_usd");
  }
  if (Number.isFinite(inUsd) && outUsd / inUsd < 0.9) {
    checks.push({ ok: false, reason: "gross_value_retention_below_90pct" });
  }
  if (quoteSlip != null && quoteSlip > slipBps * 2) {
    checks.push({
      ok: false,
      reason: "quote_min_out_slip_wide",
      quote_slip_bps: quoteSlip,
      cap_bps: slipBps,
    });
  }

  const hardFails = checks.filter((c) => !c.ok);
  if (hardFails.length) {
    return {
      ok: false,
      score: outUsd - (feeUsd || 0) * 2,
      decision: "REJECT",
      checks,
      reason: hardFails[0].reason,
      metrics: { outUsd, inUsd, feeUsd, quoteSlip },
    };
  }

  // Prefer high USD retention, penalize fees and unsupported signing.
  let score = outUsd;
  if (feeUsd != null) score -= feeUsd * 1.5;
  if (signing?.may_use === false) score -= 1000;
  // Same-symbol bridge (stable→stable) gets modest preference when retention high
  if (
    route?.source_key?.includes("usdc") &&
    route?.dest_key?.includes("usdc") &&
    Number.isFinite(inUsd) &&
    outUsd / inUsd > 0.995
  ) {
    score += 0.01;
  }

  checks.push({ ok: true, reason: "economic_metrics_ok" });
  return {
    ok: true,
    score,
    decision: "CANDIDATE",
    checks,
    metrics: { outUsd, inUsd, feeUsd, quoteSlip },
    executable_signing: signing?.may_use === true,
  };
}

export function criticReview(candidate, { allowSameChain = false } = {}) {
  if (!candidate) return { verdict: "ABSTAIN", reasons: ["no_candidate"] };
  if (candidate.score_result?.decision === "REJECT") {
    return {
      verdict: "REJECT",
      reasons: [candidate.score_result.reason || "fitter_reject"],
    };
  }
  if (
    candidate.route?.source_chain === candidate.route?.destination_chain &&
    !allowSameChain
  ) {
    return {
      verdict: "REJECT",
      reasons: ["same_chain_not_in_demo_matrix"],
    };
  }
  if (candidate.signing?.may_use === false) {
    return {
      verdict: "REJECT",
      reasons: ["signing_primitive_blocked_for_funded_path"],
      note: "May remain a discovery-only quote",
    };
  }
  if (!candidate.bound?.ok) {
    return { verdict: "REJECT", reasons: ["quote_binding_failed"] };
  }
  return { verdict: "APPROVE", reasons: [] };
}

/** Destination-chain address shape for 1Click DESTINATION_CHAIN recipientType. */
export function defaultRecipientForChain(chain, opts = {}) {
  const c = String(chain || "").toLowerCase();
  if (c === "near") {
    return (
      opts.nearRecipient ||
      process.env.NIO_MAINNET_NEAR_RECIPIENT ||
      "root.near"
    );
  }
  return (
    opts.evmRecipient ||
    process.env.NIO_MAINNET_RECIPIENT ||
    process.env.NIO_MAINNET_REFUND ||
    "0x9751874dc251d705ed571a447f7a00de5b845cf4"
  );
}

export function defaultRefundForChain(chain, opts = {}) {
  const c = String(chain || "").toLowerCase();
  if (c === "near") {
    return (
      opts.nearRefund ||
      process.env.NIO_MAINNET_NEAR_REFUND ||
      opts.nearRecipient ||
      "root.near"
    );
  }
  return (
    opts.evmRefund ||
    process.env.NIO_MAINNET_REFUND ||
    "0x9751874dc251d705ed571a447f7a00de5b845cf4"
  );
}

/**
 * Dry-quote one candidate route.
 */
export async function quoteRoute(routeDef, canonical, opts = {}) {
  const {
    amount = "1000000",
    balances = {},
    mandate = {},
    quoteFn = productionDryQuote,
  } = opts;

  const src = canonical[routeDef.source_key];
  const dst = canonical[routeDef.dest_key];
  if (!src || !dst) {
    return {
      ok: false,
      status: ROUTE_STATUS.UNSUPPORTED_ROUTE,
      route: routeDef,
      reason: "canonical_asset_missing_from_catalog",
      detail: { source_key: routeDef.source_key, dest_key: routeDef.dest_key },
    };
  }
  if (src.asset_id === dst.asset_id) {
    return {
      ok: false,
      status: ROUTE_STATUS.UNSUPPORTED_ROUTE,
      route: routeDef,
      reason: "UNSUPPORTED_ROUTE",
      detail: "identical_asset",
    };
  }

  const recipient =
    opts.recipient ||
    defaultRecipientForChain(routeDef.destination_chain, opts);
  const refundTo =
    opts.refundTo || defaultRefundForChain(routeDef.source_chain, opts);

  const request = {
    originAsset: src.asset_id,
    destinationAsset: dst.asset_id,
    amount: String(amount),
    recipient,
    refundTo,
    depositType: "ORIGIN_CHAIN",
    refundType: "ORIGIN_CHAIN",
    recipientType: "DESTINATION_CHAIN",
    slippageTolerance: opts.slippageTolerance ?? 100,
  };

  const v = validateQuoteRequest(request);
  if (!v.ok) {
    return {
      ok: false,
      status: ROUTE_STATUS.BLOCKED,
      route: routeDef,
      reason: "invalid_request",
      detail: v,
    };
  }
  const destOk = validateRecipientRefund(request, opts);
  if (!destOk.ok) {
    return {
      ok: false,
      status: ROUTE_STATUS.BLOCKED,
      route: routeDef,
      reason: "destination_rejected",
      detail: destOk,
    };
  }

  const capital = capitalAvailable(balances, src.asset_id, amount);
  const signing = requiredSigningPrimitive({
    originNetwork: routeDef.source_chain,
    depositType: "ORIGIN_CHAIN",
  });

  let quote;
  try {
    quote = await quoteFn(request, opts);
  } catch (e) {
    quote = { ok: false, reason: String(e.message || e).slice(0, 200) };
  }

  if (!quote?.ok) {
    const apiMsg =
      quote?.body?.message ||
      quote?.body?.error ||
      quote?.blocker ||
      null;
    const reason =
      apiMsg === "No liquidity available"
        ? "NO_SAFE_LIQUIDITY"
        : apiMsg || quote?.reason || "quote_failed";
    return {
      ok: false,
      status: ROUTE_STATUS.NO_SAFE_LIQUIDITY,
      route: routeDef,
      reason,
      http_status: quote?.http_status || null,
      capital,
      signing,
      source: {
        chain: routeDef.source_chain,
        asset_id: src.asset_id,
        symbol: src.symbol,
      },
      destination: {
        chain: routeDef.destination_chain,
        asset_id: dst.asset_id,
        symbol: dst.symbol,
      },
      detail: quote,
    };
  }

  const bound = bindQuoteToRequest(quote, request);
  const score_result = scoreCandidate({
    quote,
    capital,
    mandate,
    signing,
    route: routeDef,
  });

  return {
    ok: true,
    status: ROUTE_STATUS.QUOTED,
    dry: true,
    route: routeDef,
    source: {
      chain: routeDef.source_chain,
      asset_id: src.asset_id,
      symbol: src.symbol,
      decimals: src.decimals,
      contract_address: src.contract_address,
    },
    destination: {
      chain: routeDef.destination_chain,
      asset_id: dst.asset_id,
      symbol: dst.symbol,
      decimals: dst.decimals,
      contract_address: dst.contract_address,
    },
    request,
    quote,
    bound,
    capital,
    signing,
    score_result,
    amount_out: quote.amount_out,
    amount_out_usd: usdOut(quote),
    funded_execution: "DISABLED",
  };
}

/**
 * Run the representative four-route matrix + AI selection.
 */
export async function runFourChainQuoteMatrix(opts = {}) {
  const catalog = opts.catalog || (await fetchFourChainCatalog(opts));
  if (!catalog.ok) {
    return { ok: false, reason: "catalog_failed", detail: catalog };
  }
  const canonical = resolveCanonicalAssets(catalog);
  if (!canonical.complete) {
    return {
      ok: false,
      reason: "canonical_assets_incomplete",
      canonical,
      catalog_counts: catalog.counts,
    };
  }

  const routes = opts.routes || DEMO_ROUTES;
  const results = [];
  for (const route of routes) {
    // eslint-disable-next-line no-await-in-loop
    const row = await quoteRoute(route, canonical, { ...opts });
    results.push(row);
  }

  const quoted = results.filter((r) => r.ok && r.status === ROUTE_STATUS.QUOTED);
  const scored = quoted
    .map((r) => ({
      ...r,
      critic: criticReview(r),
    }))
    .filter((r) => r.score_result?.ok);

  // Only capital-verified + critic-approved are executable candidates
  const eligible = scored.filter(
    (r) =>
      r.capital?.ok &&
      r.critic?.verdict === "APPROVE" &&
      r.signing?.may_use === true
  );
  eligible.sort((a, b) => (b.score_result.score || 0) - (a.score_result.score || 0));

  // Discovery ranking (quotes only) — still not a funded authorization
  const discoveryRanked = [...quoted].sort(
    (a, b) => (b.amount_out_usd || 0) - (a.amount_out_usd || 0)
  );

  let proposal;
  if (!eligible.length) {
    proposal = {
      choice: "NO_TRADE",
      rationale:
        "No candidate passed verified capital + fitter + critic + signing readiness. Dry quotes may still exist for discovery.",
      best_discovery: discoveryRanked[0]
        ? {
            route_id: discoveryRanked[0].route.id,
            label: discoveryRanked[0].route.label,
            amount_out_usd: discoveryRanked[0].amount_out_usd,
            capital_ok: discoveryRanked[0].capital?.ok || false,
            capital_reason: discoveryRanked[0].capital?.reason || null,
            signing: discoveryRanked[0].signing?.primitive,
          }
        : null,
    };
  } else {
    const best = eligible[0];
    proposal = {
      choice: "TRADE",
      route_id: best.route.id,
      label: best.route.label,
      source_chain: best.source.chain,
      source_token: best.source.asset_id,
      destination_chain: best.destination.chain,
      destination_token: best.destination.asset_id,
      amount: best.request.amount,
      amount_out_usd: best.amount_out_usd,
      score: best.score_result.score,
      rationale: `Selected ${best.route.label} by net USD retention / fee-adjusted score ${best.score_result.score?.toFixed?.(4) ?? best.score_result.score} with critic APPROVE — not by max raw amountOut alone.`,
      binding_digest: best.bound?.binding_digest,
      funded_execution: "DISABLED",
    };
  }

  return {
    ok: true,
    dry: true,
    funded_execution: "DISABLED",
    acceptance_override: "FORBIDDEN",
    catalog_counts: catalog.counts,
    canonical_assets: {
      arb_usdc: canonical.arb_usdc.asset_id,
      base_usdc: canonical.base_usdc.asset_id,
      eth_usdc: canonical.eth_usdc.asset_id,
      eth_weth: canonical.eth_weth.asset_id,
      wrap_near: canonical.wrap_near.asset_id,
    },
    matrix: results.map((r) => ({
      id: r.route?.id,
      label: r.route?.label,
      ok: r.ok,
      status: r.status,
      reason: r.reason || null,
      amount_out: r.amount_out || null,
      amount_out_usd: r.amount_out_usd ?? null,
      capital: r.capital || null,
      signing: r.signing?.primitive || null,
      score: r.score_result?.score ?? null,
      decision: r.score_result?.decision || null,
    })),
    proposal,
    quoted_count: quoted.length,
    eligible_count: eligible.length,
    chains: Object.values(NIO_CHAINS).map((c) => c.display),
    note: "Dry quotes only. NO_TRADE is valid. Do not treat discovery ranking as authorization.",
  };
}
