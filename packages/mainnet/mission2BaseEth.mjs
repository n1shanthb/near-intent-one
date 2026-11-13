/**
 * Mission 2 — Base USDC → Ethereum USDC canary dry preflight.
 * Read-only / dry-quote only. Never funds, signs, or broadcasts.
 */
import { fetchProductionTokens, productionDryQuote } from "./intents.mjs";
import { M2_BASE_ETH_USDC } from "./canaryRouteProfiles.mjs";
import { evaluateLiveMinOutAgainstPolicy } from "./quotePath.mjs";
import { analyzeDecimalsRisk as decimalsRisk } from "./decimalsRisk.mjs";
import {
  fetchBaseGasPrice,
  estimateBaseErc20TransferGas,
  evaluateBaseGasEconomics,
  chooseAffordableUsdcAmount,
  BASE_NATIVE_USDC,
} from "./baseFunding.mjs";
import { MAINNET_USDC, MAINNET_EVM_RPCS, MAINNET_IDENTITIES } from "./identities.mjs";
import { evmErc20Balance, evmNativeBalance } from "./evmBalances.mjs";
import { ethJsonRpc } from "./canaryAdapters.mjs";
import { createViewOnlyPolicyAdapters } from "./canaryRecovery.mjs";

function assetIdOf(t) {
  return t?.assetId || t?.asset_id || null;
}

function findTok(list, pred) {
  return (Array.isArray(list) ? list : []).find(pred) || null;
}

async function loadLimits(rpc) {
  const body = {
    jsonrpc: "2.0",
    id: "1",
    method: "query",
    params: {
      request_type: "call_function",
      finality: "final",
      account_id: MAINNET_IDENTITIES.policy,
      method_name: "get_limits",
      args_base64: Buffer.from("{}").toString("base64"),
    },
  };
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!j.result?.result) return null;
  return JSON.parse(Buffer.from(j.result.result).toString("utf8"));
}

/**
 * Mission 2 dry preflight. Rechecks live Base USDC — does not assume J8B leftover.
 */
export async function runMission2BaseEthPreflight({
  env = process.env,
  route = M2_BASE_ETH_USDC,
  ethUsdHint = 3200,
  quoteFn = productionDryQuote,
  deps = {},
} = {}) {
  if (Number(route.source_chain_id) !== 8453) {
    throw new Error("mission2_requires_base_source");
  }
  if (route.destination_chain !== "ethereum") {
    throw new Error("mission2_requires_ethereum_dest");
  }

  const blockers = [];
  const warnings = [];

  const tokens =
    deps.tokens ||
    (await fetchProductionTokens({ token: env.NIO_1CLICK_JWT }));
  if (!tokens.ok) blockers.push(`tokens_unavailable:${tokens.reason || "error"}`);
  const list = tokens.tokens || [];
  const baseTok = findTok(
    list,
    (t) =>
      String(assetIdOf(t) || "").toLowerCase() === route.asset_in.toLowerCase() ||
      String(t.contractAddress || t.contract_address || "").toLowerCase() ===
        route.source_token
  );
  const ethTok = findTok(
    list,
    (t) =>
      String(assetIdOf(t) || "").toLowerCase() === route.asset_out.toLowerCase() ||
      String(t.contractAddress || t.contract_address || "").toLowerCase() ===
        MAINNET_USDC.ethereum.toLowerCase()
  );
  if (!baseTok) blockers.push("origin_base_usdc_missing_from_1click");
  if (!ethTok) blockers.push("dest_eth_usdc_missing_from_1click");

  const a =
    deps.policyAdapters || (await createViewOnlyPolicyAdapters({ env }));
  const [paused, epoch, limits] = await Promise.all([
    a.getPaused(),
    a.getMandateEpoch(),
    deps.limits || loadLimits(a.rpc),
  ]);
  const allowedAssets = limits?.allowed_assets || [];
  const allowedDest = (limits?.allowed_destinations || []).map((d) =>
    String(d).toLowerCase()
  );
  const allowedChains = limits?.allowed_chains || [];
  if (!paused) warnings.push("policy_not_paused");
  if (Number(epoch) !== 2) blockers.push(`unexpected_mandate_epoch:${epoch}`);
  if (!allowedChains.includes("eip155:8453")) blockers.push("chain_not_allowed:eip155:8453");
  if (!allowedChains.includes("eip155:1")) {
    warnings.push("dest_chain_eip155:1_not_in_allowed_chains_list_but_dest_is_asset_scoped");
  }
  if (!allowedAssets.includes(route.asset_in)) {
    blockers.push(`asset_in_not_allowed:${route.asset_in}`);
  }
  if (!allowedAssets.includes(route.asset_out)) {
    blockers.push(`asset_out_not_allowed:${route.asset_out}`);
  }
  if (!allowedDest.includes(route.recipient.toLowerCase())) {
    blockers.push(`recipient_not_allowed:${route.recipient}`);
  }
  if (!allowedDest.includes(route.refund_to.toLowerCase())) {
    blockers.push(`refund_to_not_allowed:${route.refund_to}`);
  }

  const mpc = route.signer_mpc;
  const [baseNative, baseUsdc, ethUsdcDest, nonceLatest, noncePending, gasPrice] =
    await Promise.all([
      deps.baseNative || evmNativeBalance(route.source_rpc, mpc),
      deps.baseUsdc || evmErc20Balance(route.source_rpc, BASE_NATIVE_USDC, mpc),
      deps.ethUsdcDest ||
        evmErc20Balance(MAINNET_EVM_RPCS.ethereum, MAINNET_USDC.ethereum, mpc),
      deps.nonceLatest ||
        ethJsonRpc(route.source_rpc, "eth_getTransactionCount", [mpc, "latest"]),
      deps.noncePending ||
        ethJsonRpc(route.source_rpc, "eth_getTransactionCount", [mpc, "pending"]),
      deps.gasPrice || fetchBaseGasPrice(route.source_rpc),
    ]);

  const afford = chooseAffordableUsdcAmount({
    balanceRaw: baseUsdc.raw || "0",
    requestedMaxRaw: BigInt(route.amount),
    candidates: [1_000_000n, 500_000n, 250_000n],
  });
  let amount = String(route.amount);
  let amountLabel = route.amount_label;
  if (!afford.ok) {
    blockers.push(
      `base_usdc_insufficient:have=${baseUsdc.raw || 0}:need_min_candidate=250000:j8b_leftover_rechecked=true`
    );
  } else {
    amount = afford.amount_raw;
    amountLabel = `${afford.amount_usdc} USDC`;
    if (BigInt(afford.amount_raw) < 1_000_000n) {
      warnings.push(
        `using_reduced_canary_amount:${amount}_due_to_base_balance_${baseUsdc.raw}`
      );
    }
  }

  if (!baseNative.ok || BigInt(baseNative.wei || 0) === 0n) {
    blockers.push("mpc_base_native_eth_zero");
  }

  const gasEst =
    deps.gasEstimate ||
    (await estimateBaseErc20TransferGas({
      from: mpc,
      to: "0x0000000000000000000000000000000000000001",
      amount,
      token: route.source_token,
      rpcUrl: route.source_rpc,
      fallbackGasLimit: BigInt(route.gas_limit_ceiling),
    }));
  const economics = evaluateBaseGasEconomics({
    gasPriceWei: gasPrice.ok ? gasPrice.gas_price_wei : route.max_gas_price_wei,
    gasLimit: gasEst.gas_limit,
    tradeAmountRaw: BigInt(amount || route.amount),
    ethUsdHint,
  });
  if (economics.verdict === "GAS_DISPROPORTIONATE_TO_TRADE") {
    blockers.push(`gas_disproportionate:${economics.fee_usd_approx}`);
  } else if (economics.verdict !== "OK") {
    warnings.push(`gas_verdict:${economics.verdict}`);
  }

  let quote = deps.quote;
  if (!quote && afford.ok) {
    quote = await quoteFn({
      originAsset: route.asset_in,
      destinationAsset: route.asset_out,
      amount,
      recipient: route.recipient,
      refundTo: route.refund_to,
      slippageTolerance: route.quote_slippage_bps,
    });
  }
  if (!quote) {
    quote = { ok: false, reason: "quote_skipped_no_affordable_amount" };
  }
  if (!quote.ok) {
    blockers.push(`dry_quote_failed:${quote.reason || quote.status || "error"}`);
  }

  const minOut = quote.min_amount_out || quote.quote?.minAmountOut || "0";
  const amountOut = quote.amount_out || quote.quote?.amountOut || null;
  const policyFit = quote.ok
    ? evaluateLiveMinOutAgainstPolicy({
        amountIn: amount,
        minAmountOut: minOut,
        maxSlippageBps: route.policy_max_slippage_bps,
        label: route.id,
      })
    : { result: "SKIPPED" };
  if (quote.ok && policyFit.result !== "PASS") {
    blockers.push(
      `policy_slippage_floor_rejects_min_out:min=${minOut}:floor=${policyFit.policy_floor}`
    );
    const withdrawFee = quote.quote?.withdrawFee;
    if (withdrawFee && BigInt(withdrawFee) >= 100_000n) {
      blockers.push(
        `structural_withdraw_fee:${withdrawFee}_raw_usdc_vs_max_trade_5usdc_likely_unpassable`
      );
    }
  }

  const dec = decimalsRisk({
    amountIn: amount || route.amount,
    minAmountOut: minOut || amount || route.amount,
    decimalsIn: 6,
    decimalsOut: 6,
    assetIn: route.asset_in,
    assetOut: route.asset_out,
    maxSlippageBps: route.policy_max_slippage_bps,
  });

  const go = blockers.length === 0;
  return {
    ok: go,
    verdict: go ? "READY_FOR_OWNER_APPROVAL" : "NO-GO",
    status: go ? "AWAITING_APPROVAL" : "AWAITING_FUNDING_OR_FIX",
    mutations_invoked: false,
    route: {
      id: route.id,
      label: route.label,
      amount,
      amount_label: amountLabel,
      requested_amount: route.amount,
      source_chain_id: 8453,
      dest_chain_id: 1,
      source_token: route.source_token,
      dest_token: MAINNET_USDC.ethereum.toLowerCase(),
      asset_in: route.asset_in,
      asset_out: route.asset_out,
      recipient: route.recipient,
      refund_to: route.refund_to,
      signer_mpc: mpc,
      quote_slippage_bps: route.quote_slippage_bps,
      expected_actions: [
        "ERC-20 transfer USDC (Base) from MPC → 1Click deposit",
        "1Click fill to Ethereum native USDC at MPC",
        "Verify Ethereum USDC delta ≥ min_out",
        "NEAR reconcile_pending after verified settlement (owner Ledger if needed)",
      ],
      journal_protections: [
        "exact-once broadcast via durable tx journal",
        "nonce bind before broadcast",
        "UNKNOWN RPC halt — no automatic second send",
        "separate Mission2 approval — never reuse J8B auth",
      ],
    },
    balances: {
      base_usdc_raw: baseUsdc.raw ?? null,
      base_usdc_ui: baseUsdc.ui ?? null,
      base_eth_wei: baseNative.wei ?? null,
      base_eth: baseNative.ether ?? null,
      eth_usdc_at_mpc_raw: ethUsdcDest.raw ?? null,
      afford,
      j8b_note:
        "J8B delivered 997398 Base USDC raw; this preflight re-reads live balance and does not assume sufficiency for 1 USDC",
    },
    policy: {
      paused: Boolean(paused),
      mandate_epoch: epoch,
      max_trade_value: limits?.max_trade_value,
      max_slippage_bps: limits?.max_slippage_bps,
      chain_8453_ok: allowedChains.includes("eip155:8453"),
      asset_in_ok: allowedAssets.includes(route.asset_in),
      asset_out_ok: allowedAssets.includes(route.asset_out),
      recipient_ok: allowedDest.includes(route.recipient.toLowerCase()),
      refund_ok: allowedDest.includes(route.refund_to.toLowerCase()),
    },
    base: {
      mpc,
      nonce_latest: nonceLatest.result != null ? Number(nonceLatest.result) : null,
      nonce_pending:
        noncePending.result != null ? Number(noncePending.result) : null,
      gas_price: gasPrice,
      gas_estimate: gasEst,
      economics,
    },
    quote: {
      ok: Boolean(quote.ok),
      dry: quote.dry !== false,
      amount_in: amount,
      amount_out: amountOut,
      min_amount_out: minOut,
      deposit_address: quote.deposit_address || null,
      refund_fee: quote.quote?.refundFee ?? null,
      withdraw_fee: quote.quote?.withdrawFee ?? null,
      time_estimate: quote.quote?.timeEstimate ?? null,
      policy_fit: policyFit,
      decimals: dec,
    },
    blockers,
    warnings,
    approval_boundary: {
      stop: true,
      requires_explicit_approval_for: [
        "Any Base ETH / USDC top-up if shortfall remains",
        "New Mission 2 operation approval (never reuse J8B)",
        "Funded quote + Ledger unpause window",
        "propose / request_signature / broadcast",
        "reconcile_pending after Ethereum USDC delta verify",
      ],
    },
  };
}
