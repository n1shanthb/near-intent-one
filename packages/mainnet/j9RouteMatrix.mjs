/**
 * J9 read-only route feasibility across Eth / Arb / Base / NEAR.
 * Discovery only — does not expand funded test scope.
 */
import { productionDryQuote } from "./intents.mjs";
import { evaluateLiveMinOutAgainstPolicy, ASSETS } from "./quotePath.mjs";
import { MAINNET_IDENTITIES } from "./identities.mjs";
import { NEAR_NATIVE_USDC_ASSET } from "./canaryRouteProfiles.mjs";
import { analyzeDecimalsRisk } from "./decimalsRisk.mjs";
import { requiredSigningPrimitive } from "./intents.mjs";

export const J9_SCOPED_FUNDED_ROUTES = Object.freeze([
  "m1_eth_usdc_to_near_usdc",
  "m2_base_usdc_to_near_usdc",
]);

export const J9_DISCOVERY_ROUTES = Object.freeze([
  {
    id: "eth_usdc_to_near_usdc",
    source: "ethereum",
    dest: "near",
    asset_in: ASSETS.eth_usdc.asset_id,
    asset_out: NEAR_NATIVE_USDC_ASSET,
    decimals_in: 6,
    decimals_out: 6,
    recipient: MAINNET_IDENTITIES.owner,
    refund: MAINNET_IDENTITIES.mpc_evm_address,
    funded_scope: "mission1",
  },
  {
    id: "base_usdc_to_near_usdc",
    source: "base",
    dest: "near",
    asset_in:
      "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    asset_out: NEAR_NATIVE_USDC_ASSET,
    decimals_in: 6,
    decimals_out: 6,
    recipient: MAINNET_IDENTITIES.owner,
    refund: MAINNET_IDENTITIES.mpc_evm_address,
    funded_scope: "mission2",
  },
  {
    id: "base_usdc_to_eth_usdc",
    source: "base",
    dest: "ethereum",
    asset_in:
      "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    asset_out: ASSETS.eth_usdc.asset_id,
    decimals_in: 6,
    decimals_out: 6,
    recipient: MAINNET_IDENTITIES.mpc_evm_address,
    refund: MAINNET_IDENTITIES.mpc_evm_address,
    funded_scope: "deferred",
    note: "DEFERRED — ~0.30 USDC Eth withdraw fee vs max_trade 5 USDC",
  },
  {
    id: "arb_usdc_to_base_usdc",
    source: "arbitrum",
    dest: "base",
    asset_in: ASSETS.arb_usdc.asset_id,
    asset_out:
      "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    decimals_in: 6,
    decimals_out: 6,
    recipient: MAINNET_IDENTITIES.mpc_evm_address,
    refund: MAINNET_IDENTITIES.mpc_evm_address,
    funded_scope: "done_j8b",
    note: "J8B completed — do not reopen",
  },
  {
    id: "arb_usdc_to_eth_usdc",
    source: "arbitrum",
    dest: "ethereum",
    asset_in: ASSETS.arb_usdc.asset_id,
    asset_out: ASSETS.eth_usdc.asset_id,
    decimals_in: 6,
    decimals_out: 6,
    recipient: MAINNET_IDENTITIES.mpc_evm_address,
    refund: MAINNET_IDENTITIES.mpc_evm_address,
    funded_scope: "discovery_only",
  },
  {
    id: "eth_usdc_to_base_usdc",
    source: "ethereum",
    dest: "base",
    asset_in: ASSETS.eth_usdc.asset_id,
    asset_out:
      "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    decimals_in: 6,
    decimals_out: 6,
    recipient: MAINNET_IDENTITIES.mpc_evm_address,
    refund: MAINNET_IDENTITIES.mpc_evm_address,
    funded_scope: "discovery_only",
  },
  {
    id: "eth_usdc_to_wrap_near",
    source: "ethereum",
    dest: "near",
    asset_in: ASSETS.eth_usdc.asset_id,
    asset_out: ASSETS.wrap_near.asset_id,
    decimals_in: 6,
    decimals_out: 24,
    recipient: MAINNET_IDENTITIES.owner,
    refund: MAINNET_IDENTITIES.mpc_evm_address,
    funded_scope: "discovery_only",
    note: "CROSS_DECIMAL — policy slippage unsafe",
  },
  {
    id: "near_usdc_to_eth_usdc",
    source: "near",
    dest: "ethereum",
    asset_in: NEAR_NATIVE_USDC_ASSET,
    asset_out: ASSETS.eth_usdc.asset_id,
    decimals_in: 6,
    decimals_out: 6,
    recipient: MAINNET_IDENTITIES.mpc_evm_address,
    refund: MAINNET_IDENTITIES.owner,
    funded_scope: "discovery_only",
    note: "NEAR-origin signing path not in J8B EVM canary executor",
  },
]);

export async function probeRoute(route, { amount = "1000000", slip = 50, quoteFn = productionDryQuote } = {}) {
  const signing = requiredSigningPrimitive({
    originNetwork: route.source,
  });
  const dec = analyzeDecimalsRisk({
    amountIn: amount,
    minAmountOut: amount,
    decimalsIn: route.decimals_in,
    decimalsOut: route.decimals_out,
    assetIn: route.asset_in,
    assetOut: route.asset_out,
    maxSlippageBps: 100,
  });

  let quote = null;
  let policy = null;
  try {
    quote = await quoteFn({
      originAsset: route.asset_in,
      destinationAsset: route.asset_out,
      amount,
      recipient: route.recipient,
      refundTo: route.refund,
      slippageTolerance: slip,
    });
    if (quote?.ok) {
      const minOut = quote.min_amount_out || quote.quote?.minAmountOut || "0";
      policy = evaluateLiveMinOutAgainstPolicy({
        amountIn: amount,
        minAmountOut: minOut,
        maxSlippageBps: 100,
        label: route.id,
      });
    }
  } catch (e) {
    quote = { ok: false, reason: String(e.message || e) };
  }

  const gaps = [];
  if (dec.classification !== "SAFE_SAME_DECIMALS") {
    gaps.push(`decimals:${dec.classification}`);
  }
  if (route.source === "near") {
    gaps.push("near_origin_evm_canary_executor_unsupported");
  }
  if (route.source === "ethereum") {
    gaps.push("requires_eth_l1_gas_funding");
  }
  if (!quote?.ok) gaps.push(`quote:${quote?.reason || "fail"}`);
  if (policy && policy.result !== "PASS") {
    gaps.push(`policy_floor:${policy.result}`);
  }

  let feasibility = "QUOTE_OK";
  if (!quote?.ok) feasibility = "QUOTE_FAIL";
  else if (policy?.result !== "PASS") feasibility = "POLICY_BLOCKED";
  else if (gaps.some((g) => g.includes("unsupported") || g.includes("CROSS"))) {
    feasibility = "ENGINEERING_GAP";
  }

  return {
    id: route.id,
    funded_scope: route.funded_scope,
    note: route.note || null,
    source: route.source,
    dest: route.dest,
    signing_primitive: signing,
    decimals: dec.classification,
    quote_ok: Boolean(quote?.ok),
    amount_out: quote?.amount_out || quote?.quote?.amountOut || null,
    min_out: quote?.min_amount_out || quote?.quote?.minAmountOut || null,
    refund_fee: quote?.quote?.refundFee ?? null,
    withdraw_fee: quote?.quote?.withdrawFee ?? null,
    policy_fit: policy?.result || null,
    feasibility,
    gaps,
    in_j9_funded_scope: J9_SCOPED_FUNDED_ROUTES.some((id) =>
      route.id.includes(id.replace(/^m[12]_/, "").replace(/_/g, "_"))
    ) || ["mission1", "mission2"].includes(route.funded_scope),
  };
}

export async function runJ9RouteMatrix(opts = {}) {
  const amount = opts.amount || "1000000";
  const slip = opts.slip || 50;
  const rows = [];
  for (const route of J9_DISCOVERY_ROUTES) {
    // eslint-disable-next-line no-await-in-loop
    rows.push(await probeRoute(route, { amount, slip, quoteFn: opts.quoteFn }));
  }
  return {
    ok: true,
    mutations_invoked: false,
    amount,
    slip_bps: slip,
    scoped_funded_only: J9_SCOPED_FUNDED_ROUTES,
    rows,
    summary: {
      quote_ok: rows.filter((r) => r.quote_ok).length,
      policy_pass: rows.filter((r) => r.policy_fit === "PASS").length,
      engineering_gaps: rows.filter((r) => r.feasibility === "ENGINEERING_GAP"),
      discovery_only: rows.filter((r) => r.funded_scope === "discovery_only"),
    },
  };
}
