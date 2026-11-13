/**
 * J5.2 — Find a policy-compatible live USDC→USDC quote.
 * Observation / classification only. Never deposits, funds, or broadcasts.
 */
import { productionDryQuote } from "./intents.mjs";
import {
  evaluateLiveMinOutAgainstPolicy,
  policySlippageFloor,
  ASSETS,
  MPC_EVM,
} from "./quotePath.mjs";
import { MAINNET_IDENTITIES } from "./identities.mjs";

export const MAX_TRADE_VALUE_RAW = 5_000_000n; // deployed max_trade_value
export const POLICY_SLIPPAGE_BPS = 100;

export const USDC_ASSETS = Object.freeze({
  ethereum: {
    key: "eth_usdc",
    chain: "ethereum",
    chain_id: 1,
    eip155: "eip155:1",
    asset_id: ASSETS.eth_usdc.asset_id,
    token_contract: ASSETS.eth_usdc.token_contract,
    gas_profile: "expensive",
  },
  arbitrum: {
    key: "arb_usdc",
    chain: "arbitrum",
    chain_id: 42161,
    eip155: "eip155:42161",
    asset_id: ASSETS.arb_usdc.asset_id,
    token_contract: ASSETS.arb_usdc.token_contract,
    gas_profile: "low",
  },
  base: {
    key: "base_usdc",
    chain: "base",
    chain_id: 8453,
    eip155: "eip155:8453",
    asset_id:
      "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    token_contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    gas_profile: "low",
  },
});

/** Preferred low-gas first; ethereum→arbitrum last (comparison). */
export const SCAN_ROUTES = Object.freeze([
  { id: "base_usdc_to_arb_usdc", source: "base", dest: "arbitrum", prefer: true },
  { id: "arb_usdc_to_base_usdc", source: "arbitrum", dest: "base", prefer: true },
  { id: "base_usdc_to_eth_usdc", source: "base", dest: "ethereum", prefer: true },
  { id: "arb_usdc_to_eth_usdc", source: "arbitrum", dest: "ethereum", prefer: true },
  {
    id: "eth_usdc_to_arb_usdc",
    source: "ethereum",
    dest: "arbitrum",
    prefer: false,
    note: "comparison_only_source_gas_expensive",
  },
]);

export const SCAN_SLIPS_BPS = Object.freeze([25, 30, 50, 100]);
export const SCAN_AMOUNTS_USDC = Object.freeze([1, 2, 5]);

/** Conservative ERC-20 transfer gas assumptions (wei ceilings for budget check). */
export const GAS_ASSUMPTIONS = Object.freeze({
  gas_limit: 250_000n,
  ethereum: { max_gas_price_wei: 5_000_000_000n, label: "5 gwei" }, // 5 gwei
  arbitrum: { max_gas_price_wei: 100_000_000n, label: "0.1 gwei" },
  base: { max_gas_price_wei: 100_000_000n, label: "0.1 gwei" },
  max_gas_budget_wei: 2_500_000_000_000_000n, // deployed
});

export function amountRawUsdc(usdc) {
  return BigInt(Math.round(Number(usdc) * 1e6));
}

export function estimateGasEconomics(sourceChain) {
  const profile =
    GAS_ASSUMPTIONS[sourceChain] || GAS_ASSUMPTIONS.ethereum;
  const cost =
    GAS_ASSUMPTIONS.gas_limit * BigInt(profile.max_gas_price_wei);
  return {
    gas_limit: String(GAS_ASSUMPTIONS.gas_limit),
    max_gas_price_wei: String(profile.max_gas_price_wei),
    max_gas_price_label: profile.label,
    estimated_gas_cost_wei: String(cost),
    within_max_gas_budget: cost <= GAS_ASSUMPTIONS.max_gas_budget_wei,
    max_gas_budget_wei: String(GAS_ASSUMPTIONS.max_gas_budget_wei),
    source_gas_affordability:
      sourceChain === "ethereum"
        ? "REQUIRES_MORE_ETH_FOR_MAINNET_GAS"
        : "L2_LOW_GAS_PREFERRED",
  };
}

/**
 * Classify one authentic quote result against deployed policy (no value mutation).
 */
export function classifyQuoteAgainstPolicy({
  quoteResult,
  route,
  slippageTolerance,
  amountUsdc,
  maxSlippageBps = POLICY_SLIPPAGE_BPS,
  allowedDestinations = [
    MAINNET_IDENTITIES.mpc_evm_address.toLowerCase(),
    MAINNET_IDENTITIES.owner,
  ],
  custody = {
    recipient: MPC_EVM,
    refundTo: MPC_EVM,
  },
}) {
  const reasons = [];
  const src = USDC_ASSETS[route.source];
  const dst = USDC_ASSETS[route.dest];
  const amountRaw = amountRawUsdc(amountUsdc);

  if (amountRaw > MAX_TRADE_VALUE_RAW) {
    return {
      status: "BLOCKED",
      reasons: ["exceeds_max_trade_value"],
      route_id: route.id,
      amount_usdc: amountUsdc,
      slippage_tolerance_bps: slippageTolerance,
    };
  }

  if (!quoteResult?.ok) {
    return {
      status: "BLOCKED",
      reasons: [quoteResult?.reason || "quote_failed"],
      route_id: route.id,
      amount_usdc: amountUsdc,
      slippage_tolerance_bps: slippageTolerance,
      http_status: quoteResult?.http_status || null,
    };
  }

  const verify = quoteResult.one_click_verify || {};
  if (!verify.ok) {
    reasons.push(`signature_verify:${verify.reason || "fail"}`);
  }

  const qr = quoteResult.one_click_response?.quoteRequest || {};
  const q = quoteResult.quote || {};
  if (qr.originAsset !== src.asset_id) reasons.push("origin_asset_mismatch");
  if (qr.destinationAsset !== dst.asset_id) {
    reasons.push("destination_asset_mismatch");
  }
  if (String(qr.amount) !== String(amountRaw)) reasons.push("amount_mismatch");
  if (Number(qr.slippageTolerance) !== Number(slippageTolerance)) {
    reasons.push("slippage_tolerance_echo_mismatch");
  }

  const recipient = String(qr.recipient || custody.recipient).toLowerCase();
  const refundTo = String(qr.refundTo || custody.refundTo).toLowerCase();
  const allowed = new Set(
    allowedDestinations.map((d) => String(d).toLowerCase())
  );
  if (!allowed.has(recipient)) reasons.push("recipient_not_allowed");
  if (!allowed.has(refundTo)) reasons.push("refund_to_not_allowed");

  const minOut = q.minAmountOut || quoteResult.min_amount_out;
  const amountIn = q.amountIn || quoteResult.amount_in || String(amountRaw);
  const amountOut = q.amountOut || quoteResult.amount_out;
  if (!minOut) reasons.push("missing_min_amount_out");

  const floorEval = minOut
    ? evaluateLiveMinOutAgainstPolicy({
        amountIn,
        minAmountOut: minOut,
        maxSlippageBps,
        label: route.id,
      })
    : null;
  if (floorEval && floorEval.result !== "PASS") {
    reasons.push(
      `min_out_below_policy_floor:${minOut}<${floorEval.policy_floor}`
    );
  }

  const gas = estimateGasEconomics(route.source);
  if (!gas.within_max_gas_budget) reasons.push("exceeds_max_gas_budget");

  const inUsd = q.amountInUsd != null ? Number(q.amountInUsd) : Number(amountUsdc);
  const outUsd = q.amountOutUsd != null ? Number(q.amountOutUsd) : null;
  const feeUsd =
    Number.isFinite(inUsd) && Number.isFinite(outUsd) ? inUsd - outUsd : null;
  const retention =
    Number.isFinite(inUsd) && Number.isFinite(outUsd) && inUsd > 0
      ? outUsd / inUsd
      : null;

  // Structural: if request slip already equals policy allowance, fees can push minOut under floor
  if (
    Number(slippageTolerance) >= Number(maxSlippageBps) &&
    floorEval?.result !== "PASS"
  ) {
    reasons.push("hypothesis_slip_tolerance_consumes_full_policy_budget");
  }

  const status = reasons.length === 0 ? "PASS" : "BLOCKED";
  return {
    status,
    reasons,
    route_id: route.id,
    source_chain: route.source,
    destination_chain: route.dest,
    prefer_low_gas: Boolean(route.prefer),
    amount_usdc: amountUsdc,
    amount_in_raw: String(amountIn),
    amount_out_raw: amountOut ? String(amountOut) : null,
    min_amount_out_raw: minOut ? String(minOut) : null,
    slippage_tolerance_bps: slippageTolerance,
    policy_slippage_bps: maxSlippageBps,
    policy_floor: floorEval?.policy_floor || String(policySlippageFloor(amountIn || amountRaw, maxSlippageBps)),
    floor_eval: floorEval,
    amount_in_usd: Number.isFinite(inUsd) ? inUsd : null,
    amount_out_usd: Number.isFinite(outUsd) ? outUsd : null,
    routing_fee_usd_estimate: feeUsd,
    retention_usd: retention,
    gas,
    custody: { recipient, refund_to: refundTo },
    signature_verified: Boolean(verify.ok),
    quote_hash: verify.quote_hash || null,
    correlation_id: quoteResult.correlation_id || null,
    timestamp: quoteResult.timestamp || null,
    dry: quoteResult.dry !== false,
    values_altered: false,
    asset_in_id: src.asset_id,
    asset_out_id: dst.asset_id,
    token_contract: src.token_contract,
    chain_id: src.chain_id,
  };
}

export function scorePassCandidate(row, { preferTiny = true } = {}) {
  if (row.status !== "PASS") return -Infinity;
  let score = row.retention_usd != null ? row.retention_usd * 1000 : 0;
  if (row.prefer_low_gas) score += 10;
  if (row.source_chain === "base") score += 2;
  if (row.source_chain === "arbitrum") score += 1;
  if (row.source_chain === "ethereum") score -= 5;
  // Prefer tighter request slip when both pass (more conservative quote request)
  score += (100 - Number(row.slippage_tolerance_bps || 0)) / 100;
  if (preferTiny) {
    // First real-money trade: strongly prefer 1 USDC over 2/5
    score += (6 - Number(row.amount_usdc || 6)) * 5;
  }
  return score;
}

/**
 * Run bounded dry matrix. Finite — does not loop forever.
 */
export async function scanDryQuoteMatrix(opts = {}) {
  const {
    routes = SCAN_ROUTES,
    slips = SCAN_SLIPS_BPS,
    amountsUsdc = SCAN_AMOUNTS_USDC,
    quoteFn = productionDryQuote,
    custody = {
      recipient: MPC_EVM,
      refundTo: MPC_EVM,
    },
    maxSlippageBps = POLICY_SLIPPAGE_BPS,
    delayMs = 150,
  } = opts;

  const rows = [];
  for (const route of routes) {
    const src = USDC_ASSETS[route.source];
    const dst = USDC_ASSETS[route.dest];
    for (const amountUsdc of amountsUsdc) {
      const amountRaw = amountRawUsdc(amountUsdc);
      if (amountRaw > MAX_TRADE_VALUE_RAW) continue;
      for (const slip of slips) {
        const request = {
          originAsset: src.asset_id,
          destinationAsset: dst.asset_id,
          amount: String(amountRaw),
          slippageTolerance: slip,
          recipient: custody.recipient,
          refundTo: custody.refundTo,
          depositType: "ORIGIN_CHAIN",
          refundType: "ORIGIN_CHAIN",
          recipientType: "DESTINATION_CHAIN",
        };
        // eslint-disable-next-line no-await-in-loop
        let quoteResult;
        try {
          quoteResult = await quoteFn(request, opts);
        } catch (e) {
          quoteResult = {
            ok: false,
            reason: String(e.message || e).slice(0, 200),
          };
        }
        const classified = classifyQuoteAgainstPolicy({
          quoteResult,
          route,
          slippageTolerance: slip,
          amountUsdc,
          maxSlippageBps,
          custody,
        });
        rows.push({
          ...classified,
          quote_status_label: quoteResult?.status_label || null,
          // Keep authentic response only for PASS (sanitized later) to limit evidence size
          one_click_response:
            classified.status === "PASS"
              ? quoteResult?.one_click_response || null
              : null,
          quote_result_ok: Boolean(quoteResult?.ok),
        });
        if (delayMs > 0) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }
  }

  const passes = rows
    .filter((r) => r.status === "PASS")
    .sort((a, b) => scorePassCandidate(b) - scorePassCandidate(a));
  const tinyPasses = passes
    .filter((r) => Number(r.amount_usdc) === 1 && r.prefer_low_gas)
    .sort((a, b) => scorePassCandidate(b) - scorePassCandidate(a));

  return {
    ok: true,
    dry: true,
    scanned: rows.length,
    pass_count: passes.length,
    blocked_count: rows.length - passes.length,
    best: passes[0] || null,
    /** Preferred for first tiny funded trade (1 USDC + L2 source). */
    recommended_first_tiny: tinyPasses[0] || passes.find((r) => r.amount_usdc === 1) || null,
    passes,
    rows,
    hypothesis:
      "If slippageTolerance >= policy max_slippage_bps, routing fees often push minAmountOut below floor",
  };
}

/**
 * Request one fresh non-dry quote matching a PASS dry candidate. No transfer.
 */
export async function fetchMatchingNonDryQuote(passRow, opts = {}) {
  if (!passRow || passRow.status !== "PASS") {
    return { ok: false, reason: "no_pass_candidate" };
  }
  const src = USDC_ASSETS[passRow.source_chain];
  const dst = USDC_ASSETS[passRow.destination_chain];
  const prev = process.env.NIO_MAINNET_ALLOW_FUNDED_QUOTE;
  process.env.NIO_MAINNET_ALLOW_FUNDED_QUOTE = "1";
  try {
    const quoteResult = await productionDryQuote(
      {
        originAsset: src.asset_id,
        destinationAsset: dst.asset_id,
        amount: passRow.amount_in_raw,
        slippageTolerance: passRow.slippage_tolerance_bps,
        recipient: passRow.custody.recipient,
        refundTo: passRow.custody.refund_to,
      },
      { ...opts, allowFundedQuote: true }
    );
    const classified = classifyQuoteAgainstPolicy({
      quoteResult,
      route: {
        id: passRow.route_id,
        source: passRow.source_chain,
        dest: passRow.destination_chain,
        prefer: passRow.prefer_low_gas,
      },
      slippageTolerance: passRow.slippage_tolerance_bps,
      amountUsdc: passRow.amount_usdc,
      custody: {
        recipient: passRow.custody.recipient,
        refundTo: passRow.custody.refund_to,
      },
    });
    // Non-dry extras
    const escrow = quoteResult?.deposit_address || null;
    const escrowOk = Boolean(
      quoteResult?.one_click_verify?.escrow_in_signed_hash && escrow
    );
    if (!escrowOk) classified.reasons.push("escrow_not_independently_verified");
    if (classified.reasons.length) classified.status = "BLOCKED";
    else classified.status = "PASS";

    return {
      ok: classified.status === "PASS",
      dry: false,
      deposit_sent: false,
      classified: {
        ...classified,
        deposit_address: escrow,
        escrow_in_signed_hash: Boolean(
          quoteResult?.one_click_verify?.escrow_in_signed_hash
        ),
        quote_deadline: quoteResult?.quote?.deadline || null,
        one_click_response: quoteResult?.one_click_response || null,
      },
      quoteResult,
    };
  } finally {
    if (prev === undefined) delete process.env.NIO_MAINNET_ALLOW_FUNDED_QUOTE;
    else process.env.NIO_MAINNET_ALLOW_FUNDED_QUOTE = prev;
  }
}

export function diagnoseScanFailure(scan) {
  const reasons = {};
  for (const r of scan.rows || []) {
    for (const reason of r.reasons || ["unknown"]) {
      const key = String(reason).split(":")[0];
      reasons[key] = (reasons[key] || 0) + 1;
    }
  }
  const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
  let structural = null;
  if (top[0]?.[0] === "min_out_below_policy_floor") {
    structural =
      "structural_or_fee: minAmountOut below 100bps floor — try lower slippageTolerance or accept larger retention loss; do not weaken policy";
  } else if (top[0]?.[0] === "quote_failed" || top[0]?.[0] === "NO_SAFE_LIQUIDITY") {
    structural = "liquidity_or_api: quotes unavailable for requested params";
  } else if (String(top[0]?.[0] || "").includes("signature")) {
    structural = "signature_verification_failure";
  }
  return { reason_histogram: top, assessment: structural };
}
