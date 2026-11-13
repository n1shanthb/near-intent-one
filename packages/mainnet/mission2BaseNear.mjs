/**
 * Mission 2 — Base USDC → NEAR NEP-141 USDC canary dry preflight.
 * Read-only / dry-quote only. Never funds, signs, or broadcasts.
 * Shares NEAR USDC storage registration with Mission 1 (register once).
 */
import { fetchProductionTokens, productionDryQuote } from "./intents.mjs";
import {
  M2_BASE_NEAR_USDC,
  NEAR_NATIVE_USDC_CONTRACT,
  assertRouteAssetIsolation,
} from "./canaryRouteProfiles.mjs";
import { evaluateLiveMinOutAgainstPolicy } from "./quotePath.mjs";
import { analyzeDecimalsRisk as decimalsRisk } from "./decimalsRisk.mjs";
import {
  fetchBaseGasPrice,
  estimateBaseErc20TransferGas,
  evaluateBaseGasEconomics,
  chooseAffordableUsdcAmount,
  BASE_NATIVE_USDC,
} from "./baseFunding.mjs";
import { MAINNET_IDENTITIES } from "./identities.mjs";
import { evmErc20Balance, evmNativeBalance } from "./evmBalances.mjs";
import { ethJsonRpc } from "./canaryAdapters.mjs";
import { createViewOnlyPolicyAdapters } from "./canaryRecovery.mjs";
import { checkNearFtStorageRegistered } from "./canarySettlement.mjs";

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

async function quoteWithRetry(quoteFn, args, { retries = 2 } = {}) {
  let last = null;
  for (let i = 0; i <= retries; i++) {
    // eslint-disable-next-line no-await-in-loop
    last = await quoteFn(args);
    if (last?.ok) return last;
    const reason = String(last?.reason || "");
    if (!/network|tls|timeout|fetch/i.test(reason) && last?.status !== 429) {
      return last;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  return last;
}

/**
 * Try candidate amounts ≤ balance until a quote clears the policy floor.
 * Never exceeds live balance or requested max. Never relaxes policy max.
 * Slip candidates must be ≤ policy max (default tries 50 then 25).
 */
export async function findPolicyCompliantAmount({
  balanceRaw,
  requestedMaxRaw = 1_000_000n,
  route,
  quoteFn,
  slipBps,
  slipCandidates = null,
  policyMaxSlipBps = 100,
}) {
  const have = BigInt(balanceRaw || 0);
  const max = BigInt(requestedMaxRaw);
  const afford = chooseAffordableUsdcAmount({
    balanceRaw: have.toString(),
    requestedMaxRaw: max,
    candidates: [1_000_000n, 900_000n, 750_000n, 500_000n, 250_000n],
    includeExactBalance: true,
  });
  if (!afford.ok) {
    return {
      ok: false,
      reason: "balance_below_min_candidate",
      balance_raw: have.toString(),
      shortfall_for_1usdc: (1_000_000n - have).toString(),
    };
  }

  const trials = [];
  const seen = new Set();
  const push = (v) => {
    const b = BigInt(v);
    if (b <= 0n || b > have || b > max) return;
    const s = b.toString();
    if (seen.has(s)) return;
    seen.add(s);
    trials.push(b);
  };
  push(afford.amount_raw);
  push(have);
  for (const c of [1_000_000n, 900_000n, 750_000n, 500_000n, 250_000n]) push(c);
  trials.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

  const slips = (slipCandidates || [slipBps, 50, 25])
    .map((s) => Number(s))
    .filter((s) => Number.isFinite(s) && s > 0 && s <= policyMaxSlipBps);
  const slipList = [...new Set(slips.length ? slips : [50, 25])];

  const attempts = [];
  for (const amount of trials) {
    for (const slip of slipList) {
      // eslint-disable-next-line no-await-in-loop
      const quote = await quoteWithRetry(quoteFn, {
        originAsset: route.asset_in,
        destinationAsset: route.asset_out,
        amount: amount.toString(),
        recipient: route.recipient,
        refundTo: route.refund_to,
        slippageTolerance: slip,
      });
      const minOut = quote.min_amount_out || quote.quote?.minAmountOut || "0";
      const policy = quote.ok
        ? evaluateLiveMinOutAgainstPolicy({
            amountIn: amount.toString(),
            minAmountOut: minOut,
            maxSlippageBps: policyMaxSlipBps,
            label: `${route.id}:${amount}@${slip}`,
          })
        : { result: "QUOTE_FAIL" };
      attempts.push({
        amount: amount.toString(),
        slip_bps: slip,
        quote_ok: Boolean(quote.ok),
        min_out: minOut,
        amount_out: quote.amount_out || quote.quote?.amountOut || null,
        refund_fee: quote.quote?.refundFee ?? null,
        withdraw_fee: quote.quote?.withdrawFee ?? null,
        policy: policy.result,
        floor: policy.policy_floor,
        reason: quote.ok ? null : quote.reason || null,
      });
      if (quote.ok && policy.result === "PASS") {
        return {
          ok: true,
          amount_raw: amount.toString(),
          amount_usdc: Number(amount) / 1e6,
          slip_bps: slip,
          quote,
          policy,
          attempts,
          balance_raw: have.toString(),
          shortfall_for_1usdc:
            have < 1_000_000n ? (1_000_000n - have).toString() : "0",
        };
      }
    }
  }
  return {
    ok: false,
    reason: "no_policy_compliant_amount_within_balance",
    balance_raw: have.toString(),
    shortfall_for_1usdc: have < 1_000_000n ? (1_000_000n - have).toString() : "0",
    attempts,
  };
}

export async function runMission2BaseNearPreflight({
  env = process.env,
  route = M2_BASE_NEAR_USDC,
  ethUsdHint = 3200,
  quoteFn = productionDryQuote,
  deps = {},
} = {}) {
  assertRouteAssetIsolation(route, {
    token: route.source_token,
    assetIn: route.asset_in,
    assetOut: route.asset_out,
    chainId: route.source_chain_id,
  });
  if (Number(route.source_chain_id) !== 8453) {
    throw new Error("mission2_requires_base_source");
  }
  if (route.destination_chain !== "near") {
    throw new Error("mission2_requires_near_dest");
  }

  const blockers = [];
  const warnings = [];

  const tokens =
    deps.tokens ||
    (await fetchProductionTokens({ token: env.NIO_1CLICK_JWT }));
  if (!tokens.ok) {
    warnings.push(`tokens_unavailable:${tokens.reason || "error"}`);
  }
  const list = tokens.tokens || [];
  const baseTok = findTok(
    list,
    (t) =>
      String(assetIdOf(t) || "").toLowerCase() === route.asset_in.toLowerCase() ||
      String(t.contractAddress || t.contract_address || "").toLowerCase() ===
        route.source_token
  );
  const nearTok = findTok(
    list,
    (t) =>
      String(assetIdOf(t) || "") === route.asset_out ||
      String(t.contractAddress || t.contract_address || "") ===
        NEAR_NATIVE_USDC_CONTRACT
  );
  if (tokens.ok && !baseTok) blockers.push("origin_base_usdc_missing_from_1click");
  if (tokens.ok && !nearTok) blockers.push("dest_near_usdc_missing_from_1click");
  if (!tokens.ok) {
    warnings.push(
      "proceeding_with_canonical_asset_ids_policy_allowlist_still_required"
    );
  }

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
  if (!allowedChains.includes("eip155:8453")) {
    blockers.push("chain_not_allowed:eip155:8453");
  }
  if (!allowedAssets.includes(route.asset_in)) {
    blockers.push(`asset_in_not_allowed:${route.asset_in}`);
  }
  if (!allowedAssets.includes(route.asset_out)) {
    blockers.push(`asset_out_not_allowed:${route.asset_out}`);
  }
  if (!allowedDest.includes(String(route.recipient).toLowerCase())) {
    blockers.push(`recipient_not_allowed:${route.recipient}`);
  }
  if (!allowedDest.includes(String(route.refund_to).toLowerCase())) {
    blockers.push(`refund_to_not_allowed:${route.refund_to}`);
  }
  const maxTrade = BigInt(limits?.max_trade_value || "5000000");
  if (maxTrade < 1_000_000n) {
    blockers.push(`max_trade_below_1usdc:${maxTrade}`);
  }

  const mpc = route.signer_mpc;
  const [baseNative, baseUsdc, nonceLatest, noncePending, gasPrice, storage] =
    await Promise.all([
      deps.baseNative || evmNativeBalance(route.source_rpc, mpc),
      deps.baseUsdc ||
        evmErc20Balance(route.source_rpc, BASE_NATIVE_USDC, mpc),
      deps.nonceLatest ||
        ethJsonRpc(route.source_rpc, "eth_getTransactionCount", [mpc, "latest"]),
      deps.noncePending ||
        ethJsonRpc(route.source_rpc, "eth_getTransactionCount", [mpc, "pending"]),
      deps.gasPrice || fetchBaseGasPrice(route.source_rpc),
      deps.storage ||
        checkNearFtStorageRegistered({
          accountId: route.recipient,
          tokenContract: NEAR_NATIVE_USDC_CONTRACT,
          rpcUrl: a.rpc,
        }),
    ]);

  if (!storage.ok || !storage.registered) {
    blockers.push(
      "near_usdc_storage_unregistered:shared_with_mission1_register_once"
    );
  }

  const amountSearch =
    deps.amountSearch ||
    (await findPolicyCompliantAmount({
      balanceRaw: baseUsdc.raw || "0",
      requestedMaxRaw: 1_000_000n,
      route,
      quoteFn,
      slipBps: route.quote_slippage_bps,
      policyMaxSlipBps: route.policy_max_slippage_bps,
    }));

  let amount = null;
  let amountLabel = null;
  let quote = { ok: false, reason: "no_amount" };
  let policyFit = { result: "SKIPPED" };

  if (!amountSearch.ok) {
    blockers.push(
      `no_policy_compliant_amount:have=${baseUsdc.raw}:shortfall_1usdc=${amountSearch.shortfall_for_1usdc}:${amountSearch.reason}`
    );
  } else {
    amount = amountSearch.amount_raw;
    amountLabel = `${amountSearch.amount_usdc} USDC`;
    quote = amountSearch.quote;
    policyFit = amountSearch.policy;
    if (amountSearch.slip_bps != null) {
      route = { ...route, quote_slippage_bps: amountSearch.slip_bps };
    }
    if (BigInt(amount) < 1_000_000n) {
      warnings.push(
        `using_balance_capped_amount:${amount}_live_base_usdc=${baseUsdc.raw}`
      );
    }
    if (amountSearch.slip_bps && amountSearch.slip_bps !== 50) {
      warnings.push(`quote_slippage_bps_selected:${amountSearch.slip_bps}`);
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
      amount: amount || "500000",
      token: route.source_token,
      rpcUrl: route.source_rpc,
      fallbackGasLimit: BigInt(route.gas_limit_ceiling),
    }));
  const economics = evaluateBaseGasEconomics({
    gasPriceWei: gasPrice.ok ? gasPrice.gas_price_wei : route.max_gas_price_wei,
    gasLimit: gasEst.gas_limit,
    tradeAmountRaw: BigInt(amount || "500000"),
    ethUsdHint,
  });
  if (economics.verdict === "GAS_DISPROPORTIONATE_TO_TRADE") {
    blockers.push(`gas_disproportionate:${economics.fee_usd_approx}`);
  } else if (economics.verdict !== "OK") {
    warnings.push(`gas_verdict:${economics.verdict}`);
  }

  const minOut = quote.min_amount_out || quote.quote?.minAmountOut || "0";
  const amountOut = quote.amount_out || quote.quote?.amountOut || null;
  const dec = decimalsRisk({
    amountIn: amount || "1000000",
    minAmountOut: minOut || amount || "1000000",
    decimalsIn: 6,
    decimalsOut: 6,
    assetIn: route.asset_in,
    assetOut: route.asset_out,
    maxSlippageBps: route.policy_max_slippage_bps,
  });
  if (dec.classification !== "SAFE_SAME_DECIMALS") {
    blockers.push(`decimals_risk:${dec.classification}`);
  }

  const go = blockers.length === 0;
  return {
    ok: go,
    verdict: go ? "READY_FOR_OWNER_APPROVAL" : "NO-GO",
    status: go ? "AWAITING_APPROVAL" : "AWAITING_FUNDING_OR_FIX",
    mutations_invoked: false,
    deferred_base_to_eth: true,
    route: {
      id: route.id,
      label: route.label,
      amount,
      amount_label: amountLabel,
      requested_max: "1000000",
      source_chain_id: 8453,
      source_token: route.source_token,
      asset_in: route.asset_in,
      asset_out: route.asset_out,
      destination_kind: "nep141",
      recipient: route.recipient,
      refund_to: route.refund_to,
      signer_mpc: mpc,
      quote_slippage_bps: amountSearch.slip_bps || route.quote_slippage_bps,
      expected_actions: [
        "ERC-20 transfer USDC (Base) from MPC → 1Click deposit",
        "1Click fill to NEAR NEP-141 USDC at nishanthb.near",
        "Verify NEAR ft_balance_of delta ≥ min_out",
        "NEAR reconcile_pending after verified settlement (owner Ledger if needed)",
      ],
      journal_protections: [
        "exact-once broadcast via durable tx journal",
        "nonce bind before broadcast",
        "UNKNOWN RPC halt — no automatic second send",
        "separate Mission2 approval — never reuse J8B auth",
        "chain isolation: Base source ≠ Arb J8B",
      ],
    },
    balances: {
      base_usdc_raw: baseUsdc.raw ?? null,
      base_usdc_ui: baseUsdc.ui ?? null,
      base_eth_wei: baseNative.wei ?? null,
      base_eth: baseNative.ether ?? null,
      amount_search: amountSearch,
      j8b_note:
        "J8B delivered 997398 Base USDC; this preflight re-reads live balance and caps amount ≤ balance",
    },
    policy: {
      paused: Boolean(paused),
      mandate_epoch: epoch,
      max_trade_value: limits?.max_trade_value,
      max_slippage_bps: limits?.max_slippage_bps,
      chain_8453_ok: allowedChains.includes("eip155:8453"),
      asset_in_ok: allowedAssets.includes(route.asset_in),
      asset_out_ok: allowedAssets.includes(route.asset_out),
      recipient_ok: allowedDest.includes(String(route.recipient).toLowerCase()),
      refund_ok: allowedDest.includes(String(route.refund_to).toLowerCase()),
    },
    near_destination: {
      recipient: route.recipient,
      storage,
      token_contract: NEAR_NATIVE_USDC_CONTRACT,
      shared_with_mission1: true,
      register_once: true,
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
        "Coordinated funding (Eth USDC+ETH, Base ETH gas, one NEAR USDC storage_deposit)",
        "New Mission 2 operation approval (never reuse J8B or Mission 1)",
        "Funded quote + Ledger unpause window",
        "propose / request_signature / broadcast",
        "reconcile_pending after NEAR USDC delta verify",
      ],
    },
  };
}

/** Alias kept for older imports — redirects to Base→NEAR. */
export async function runMission2BaseEthPreflight(opts = {}) {
  return {
    ok: false,
    verdict: "NO-GO",
    status: "DEFERRED",
    mutations_invoked: false,
    reason: "base_to_eth_deferred_use_runMission2BaseNearPreflight",
    note: "Owner retargeted Mission 2 to Base→NEAR USDC",
    ...(opts.includeNear !== false
      ? { near_retarget: await runMission2BaseNearPreflight(opts) }
      : {}),
  };
}
