/**
 * Mission 1 — Ethereum → NEAR USDC canary dry preflight.
 * Read-only / dry-quote only. Never unpause, propose, sign, broadcast, or fund.
 */
import { fetchProductionTokens, productionDryQuote } from "./intents.mjs";
import {
  M1_ETH_NEAR_USDC,
  assertRouteAssetIsolation,
  NEAR_NATIVE_USDC_CONTRACT,
} from "./canaryRouteProfiles.mjs";
import { evaluateLiveMinOutAgainstPolicy } from "./quotePath.mjs";
import { analyzeDecimalsRisk as decimalsRisk } from "./decimalsRisk.mjs";
import {
  fetchEthereumGasPrice,
  estimateEthereumErc20TransferGas,
  evaluateEthereumGasEconomics,
  ETHEREUM_NATIVE_USDC,
} from "./ethereumFunding.mjs";
import { evmErc20Balance, evmNativeBalance } from "./evmBalances.mjs";
import { ethJsonRpc } from "./canaryAdapters.mjs";
import { createViewOnlyPolicyAdapters } from "./canaryRecovery.mjs";
import { MAINNET_IDENTITIES } from "./identities.mjs";
import { checkNearFtStorageRegistered } from "./canarySettlement.mjs";

function tokenMeta(list, pred) {
  const arr = Array.isArray(list) ? list : [];
  return arr.find(pred) || null;
}

function assetIdOf(t) {
  return t?.assetId || t?.asset_id || null;
}

/**
 * Full Mission 1 read-only readiness report.
 */
export async function runMission1EthNearPreflight({
  env = process.env,
  route = M1_ETH_NEAR_USDC,
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

  const blockers = [];
  const warnings = [];

  const tokens =
    deps.tokens ||
    (await fetchProductionTokens({ token: env.NIO_1CLICK_JWT }));
  if (!tokens.ok) {
    blockers.push(`tokens_unavailable:${tokens.reason || "error"}`);
  }
  const list = tokens.tokens || [];
  const ethTok = tokenMeta(
    list,
    (t) =>
      String(assetIdOf(t) || "").toLowerCase() === route.asset_in.toLowerCase() ||
      String(t.contractAddress || t.contract_address || "").toLowerCase() ===
        route.source_token
  );
  const nearTok = tokenMeta(
    list,
    (t) =>
      String(assetIdOf(t) || "") === route.asset_out ||
      String(t.contractAddress || t.contract_address || "") ===
        NEAR_NATIVE_USDC_CONTRACT
  );
  const wrapTok = tokenMeta(
    list,
    (t) =>
      String(assetIdOf(t) || "") === "nep141:wrap.near" ||
      String(t.contractAddress || t.contract_address || "") === "wrap.near"
  );
  if (!ethTok) blockers.push("origin_eth_usdc_missing_from_1click");
  if (!nearTok) blockers.push("dest_near_usdc_missing_from_1click");
  if (wrapTok) {
    warnings.push(
      "wrap.near_is_listed_but_not_selected — Mission 1 uses NEP-141 USDC (6 decimals), not wrap.near (24)"
    );
  }

  const a =
    deps.policyAdapters ||
    (await createViewOnlyPolicyAdapters({ env }));
  const [paused, epoch, limits] = await Promise.all([
    a.getPaused(),
    a.getMandateEpoch(),
    deps.limits ||
      (async () => {
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
        const res = await fetch(a.rpc, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = await res.json();
        if (!j.result?.result) return null;
        return JSON.parse(Buffer.from(j.result.result).toString("utf8"));
      })(),
  ]);

  const allowedAssets = limits?.allowed_assets || [];
  const allowedDest = limits?.allowed_destinations || [];
  const allowedChains = limits?.allowed_chains || [];
  if (!paused) warnings.push("policy_not_paused — keep paused until approved window");
  if (Number(epoch) !== 2) blockers.push(`unexpected_mandate_epoch:${epoch}`);
  if (!allowedChains.includes(route.source_eip155)) {
    blockers.push(`chain_not_allowed:${route.source_eip155}`);
  }
  if (!allowedAssets.includes(route.asset_in)) {
    blockers.push(`asset_in_not_allowed:${route.asset_in}`);
  }
  if (!allowedAssets.includes(route.asset_out)) {
    blockers.push(`asset_out_not_allowed:${route.asset_out}`);
  }
  if (!allowedDest.includes(route.recipient)) {
    blockers.push(`recipient_not_allowed:${route.recipient}`);
  }
  if (
    !allowedDest.map((d) => String(d).toLowerCase()).includes(route.refund_to)
  ) {
    blockers.push(`refund_to_not_allowed:${route.refund_to}`);
  }

  const mpc = route.signer_mpc;
  const [native, usdc, nonceLatest, noncePending, gasPrice] = await Promise.all([
    deps.nativeBalance || evmNativeBalance(route.source_rpc, mpc),
    deps.usdcBalance ||
      evmErc20Balance(route.source_rpc, ETHEREUM_NATIVE_USDC, mpc),
    deps.nonceLatest ||
      ethJsonRpc(route.source_rpc, "eth_getTransactionCount", [mpc, "latest"]),
    deps.noncePending ||
      ethJsonRpc(route.source_rpc, "eth_getTransactionCount", [mpc, "pending"]),
    deps.gasPrice || fetchEthereumGasPrice(route.source_rpc),
  ]);

  const amount = String(route.amount);
  if (!usdc.ok || BigInt(usdc.raw || 0) < BigInt(amount)) {
    blockers.push(
      `mpc_eth_usdc_insufficient:have=${usdc.raw || 0}:need=${amount}`
    );
  }
  if (!native.ok || BigInt(native.wei || 0) === 0n) {
    blockers.push("mpc_ethereum_native_eth_zero");
  }

  const gasEst =
    deps.gasEstimate ||
    (await estimateEthereumErc20TransferGas({
      from: mpc,
      to: "0x0000000000000000000000000000000000000001",
      amount,
      token: route.source_token,
      rpcUrl: route.source_rpc,
      fallbackGasLimit: BigInt(route.gas_limit_ceiling),
    }));
  const economics = evaluateEthereumGasEconomics({
    gasPriceWei: gasPrice.ok ? gasPrice.gas_price_wei : route.max_gas_price_wei,
    gasLimit: gasEst.gas_limit,
    tradeAmountRaw: BigInt(amount),
    ethUsdHint,
  });
  if (economics.verdict === "GAS_DISPROPORTIONATE_TO_TRADE") {
    blockers.push(
      `gas_disproportionate:fee_usd≈${economics.fee_usd_approx}:trade=${economics.trade_usdc}`
    );
  } else if (economics.verdict !== "OK") {
    warnings.push(`gas_verdict:${economics.verdict}`);
  }

  const storage =
    deps.storage ||
    (await checkNearFtStorageRegistered({
      accountId: route.recipient,
      tokenContract: NEAR_NATIVE_USDC_CONTRACT,
      rpcUrl: a.rpc,
    }));
  if (!storage.ok || !storage.registered) {
    blockers.push(
      "near_usdc_storage_unregistered:owner_must_storage_deposit_before_receive"
    );
  }

  const quote =
    deps.quote ||
    (await quoteFn({
      originAsset: route.asset_in,
      destinationAsset: route.asset_out,
      amount,
      recipient: route.recipient,
      refundTo: route.refund_to,
      slippageTolerance: route.quote_slippage_bps,
    }));
  if (!quote.ok) {
    blockers.push(`dry_quote_failed:${quote.reason || quote.status || "error"}`);
  }

  const minOut = quote.min_amount_out || quote.quote?.minAmountOut || "0";
  const amountOut = quote.amount_out || quote.quote?.amountOut || null;
  const policyFit = evaluateLiveMinOutAgainstPolicy({
    amountIn: amount,
    minAmountOut: minOut,
    maxSlippageBps: route.policy_max_slippage_bps,
    label: route.id,
  });
  if (policyFit.result !== "PASS") {
    blockers.push(
      `policy_slippage_floor_rejects_min_out:min=${minOut}:floor=${policyFit.policy_floor}`
    );
  }

  const dec = decimalsRisk({
    amountIn: amount,
    minAmountOut: minOut || amount,
    decimalsIn: route.decimals_in,
    decimalsOut: route.decimals_out,
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
    mutations_invoked: false,
    route: {
      id: route.id,
      label: route.label,
      amount: route.amount,
      amount_label: route.amount_label,
      source_chain_id: route.source_chain_id,
      source_token: route.source_token,
      asset_in: route.asset_in,
      asset_out: route.asset_out,
      destination_kind: route.destination_kind,
      recipient: route.recipient,
      refund_to: route.refund_to,
      signer_mpc: route.signer_mpc,
      quote_slippage_bps: route.quote_slippage_bps,
      expected_actions: [
        "ERC-20 transfer USDC (Ethereum) from MPC → 1Click deposit",
        "1Click fill to NEP-141 NEAR USDC at nishanthb.near",
        "NEAR reconcile_pending after verified destination delta (owner Ledger if reconciler unset)",
      ],
    },
    tokens: {
      ok: tokens.ok,
      eth_usdc: Boolean(ethTok),
      near_usdc: Boolean(nearTok),
      wrap_near_listed: Boolean(wrapTok),
      near_usdc_decimals: nearTok?.decimals ?? 6,
      distinction:
        "Destination is NEP-141 USDC contract on NEAR — not native NEAR, not wrap.near, not an intents ledger balance id",
    },
    policy: {
      paused: Boolean(paused),
      mandate_epoch: epoch,
      max_trade_value: limits?.max_trade_value,
      max_slippage_bps: limits?.max_slippage_bps,
      max_gas_budget: limits?.max_gas_budget,
      chain_ok: allowedChains.includes(route.source_eip155),
      asset_in_ok: allowedAssets.includes(route.asset_in),
      asset_out_ok: allowedAssets.includes(route.asset_out),
      recipient_ok: allowedDest.includes(route.recipient),
      refund_ok: allowedDest
        .map((d) => String(d).toLowerCase())
        .includes(route.refund_to),
    },
    ethereum: {
      mpc,
      native_wei: native.wei ?? null,
      native_eth: native.ether ?? null,
      usdc_raw: usdc.raw ?? null,
      nonce_latest: nonceLatest.result != null ? Number(nonceLatest.result) : null,
      nonce_pending:
        noncePending.result != null ? Number(noncePending.result) : null,
      gas_price: gasPrice,
      gas_estimate: gasEst,
      economics,
    },
    near_destination: {
      recipient: route.recipient,
      storage,
      token_contract: NEAR_NATIVE_USDC_CONTRACT,
    },
    quote: {
      ok: Boolean(quote.ok),
      dry: quote.dry !== false,
      amount_in: quote.amount_in || amount,
      amount_out: amountOut,
      min_amount_out: minOut,
      deposit_address: quote.deposit_address || null,
      deadline: quote.deadline || null,
      refund_fee: quote.quote?.refundFee ?? null,
      withdraw_fee: quote.quote?.withdrawFee ?? null,
      time_estimate: quote.quote?.timeEstimate ?? null,
      policy_fit: policyFit,
      decimals: dec,
      note: "dry quote — deposit_address may be null until funded quote + approval",
    },
    blockers,
    warnings,
    approval_boundary: {
      stop: true,
      requires_explicit_approval_for: [
        "Fund MPC Ethereum address with USDC + ETH gas (owner funding — not auto)",
        "NEAR USDC storage_deposit for nishanthb.near (owner)",
        "Create new Mission 1 operation approval (never reuse J8B)",
        "Funded 1Click quote + Ledger unpause window",
        "propose_quoted_evm_transfer / request_signature / broadcast",
        "reconcile_pending after settlement verify",
      ],
      proposed_trade: {
        amount: "1000000",
        amount_label: "1 USDC",
        source_fee_budget_wei: economics.fee_wei,
        source_fee_eth: economics.fee_eth,
        source_fee_usd_approx: economics.fee_usd_approx,
        destination_asset: route.asset_out,
        min_output: minOut,
        signer: mpc,
        recipient: route.recipient,
        refund_route: `${route.refund_to} on Ethereum (ORIGIN_CHAIN)`,
        quote_slippage_bps: route.quote_slippage_bps,
      },
    },
  };
}
