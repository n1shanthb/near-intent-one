/**
 * Base (eip155:8453) gas helpers for canary routes.
 */
import { MAINNET_EVM_RPCS, MAINNET_USDC } from "./identities.mjs";
import { GAS_ASSUMPTIONS } from "./j5_2.quoteScan.mjs";
import { erc20TransferData } from "../intents-codec/quote-auth.mjs";

export const BASE_CHAIN_ID = 8453;
export const BASE_NATIVE_USDC = MAINNET_USDC.base.toLowerCase();

async function ethRpc(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

export async function fetchBaseGasPrice(rpcUrl = MAINNET_EVM_RPCS.base) {
  const j = await ethRpc(rpcUrl, "eth_gasPrice", []);
  if (j.error || j.result == null) {
    return { ok: false, reason: "gas_price_rpc_failed", detail: j.error || null };
  }
  const wei = BigInt(j.result);
  return {
    ok: true,
    gas_price_wei: wei.toString(),
    gas_price_gwei: Number(wei) / 1e9,
  };
}

export async function estimateBaseErc20TransferGas({
  from,
  to,
  amount,
  token = BASE_NATIVE_USDC,
  rpcUrl = MAINNET_EVM_RPCS.base,
  fallbackGasLimit = GAS_ASSUMPTIONS.gas_limit,
} = {}) {
  const dataBuf = erc20TransferData(to, amount);
  const data = "0x" + Buffer.from(dataBuf).toString("hex");
  const j = await ethRpc(rpcUrl, "eth_estimateGas", [{ from, to: token, data }]);
  if (j.error || j.result == null) {
    return {
      ok: true,
      estimated: false,
      gas_limit: String(fallbackGasLimit),
      reason: "estimate_fallback",
      detail: j.error?.message || j.error || null,
    };
  }
  const gas = BigInt(j.result);
  const withHeadroom = (gas * 120n) / 100n;
  const capped =
    withHeadroom > BigInt(fallbackGasLimit) ? BigInt(fallbackGasLimit) : withHeadroom;
  return {
    ok: true,
    estimated: true,
    gas_limit: capped.toString(),
    eth_estimate: gas.toString(),
  };
}

export function evaluateBaseGasEconomics({
  gasPriceWei,
  gasLimit,
  tradeAmountRaw = 1_000_000n,
  ethUsdHint = null,
}) {
  const gp = BigInt(gasPriceWei);
  const gl = BigInt(gasLimit);
  const feeWei = gp * gl;
  const feeEth = Number(feeWei) / 1e18;
  const tradeUsdc = Number(tradeAmountRaw) / 1e6;
  const feeUsd = ethUsdHint != null ? feeEth * Number(ethUsdHint) : null;
  const withinCeiling = gp <= GAS_ASSUMPTIONS.base.max_gas_price_wei;
  const withinBudget = feeWei <= GAS_ASSUMPTIONS.max_gas_budget_wei;
  let verdict = "OK";
  if (!withinCeiling) verdict = "GAS_PRICE_ABOVE_CEILING";
  if (!withinBudget) verdict = "GAS_ABOVE_POLICY_BUDGET";
  if (feeUsd != null && feeUsd >= tradeUsdc) {
    verdict = "GAS_DISPROPORTIONATE_TO_TRADE";
  }
  return {
    gas_price_wei: gp.toString(),
    gas_limit: gl.toString(),
    fee_wei: feeWei.toString(),
    fee_eth: feeEth,
    fee_usd_approx: feeUsd,
    trade_usdc: tradeUsdc,
    within_gas_price_ceiling: withinCeiling,
    within_max_gas_budget: withinBudget,
    verdict,
  };
}

/**
 * Choose largest canary amount ≤ balance that still clears policy floor at given slip.
 * Never increases beyond requestedMax. Returns null if none.
 */
export function chooseAffordableUsdcAmount({
  balanceRaw,
  requestedMaxRaw = 1_000_000n,
  candidates = [1_000_000n, 500_000n, 250_000n],
  includeExactBalance = true,
}) {
  const have = BigInt(balanceRaw || 0);
  const max = BigInt(requestedMaxRaw);
  const pool = new Set(
    [...candidates]
      .map((c) => BigInt(c))
      .filter((c) => c <= max && c > 0n)
      .map((c) => c.toString())
  );
  // Prefer spending available balance when below 1 USDC (e.g. J8B leftover 997398).
  if (includeExactBalance && have > 0n && have <= max) {
    pool.add(have.toString());
  }
  if (have >= max) pool.add(max.toString());
  const sorted = [...pool]
    .map((c) => BigInt(c))
    .filter((c) => c <= have)
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  for (const c of sorted) {
    return {
      ok: true,
      amount_raw: c.toString(),
      amount_usdc: Number(c) / 1e6,
      balance_raw: have.toString(),
      shortfall_for_1usdc: have < 1_000_000n ? (1_000_000n - have).toString() : "0",
      used_exact_balance: c === have && have < max,
    };
  }
  return {
    ok: false,
    amount_raw: null,
    balance_raw: have.toString(),
    shortfall_for_1usdc: have < 1_000_000n ? (1_000_000n - have).toString() : "0",
    note: "balance_below_all_candidates",
  };
}
