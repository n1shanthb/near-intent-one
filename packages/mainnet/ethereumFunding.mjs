/**
 * Ethereum mainnet (eip155:1) gas / fee helpers for canary routes.
 * Distinct from Arbitrum attestor ceilings (0.1 gwei).
 */
import { MAINNET_EVM_RPCS, MAINNET_USDC } from "./identities.mjs";
import { GAS_ASSUMPTIONS } from "./j5_2.quoteScan.mjs";
import { erc20TransferData } from "../intents-codec/quote-auth.mjs";

export const ETHEREUM_CHAIN_ID = 1;
export const ETHEREUM_NATIVE_USDC = MAINNET_USDC.ethereum.toLowerCase();

async function ethRpc(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

export async function fetchEthereumGasPrice(rpcUrl = MAINNET_EVM_RPCS.ethereum) {
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

/**
 * Estimate ERC-20 transfer gas on Ethereum. Falls back to conservative ceiling.
 */
export async function estimateEthereumErc20TransferGas({
  from,
  to,
  amount,
  token = ETHEREUM_NATIVE_USDC,
  rpcUrl = MAINNET_EVM_RPCS.ethereum,
  fallbackGasLimit = GAS_ASSUMPTIONS.gas_limit,
} = {}) {
  const dataBuf = erc20TransferData(to, amount);
  const data = "0x" + Buffer.from(dataBuf).toString("hex");
  const j = await ethRpc(rpcUrl, "eth_estimateGas", [
    { from, to: token, data },
  ]);
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
  // 20% headroom, still capped by assumption ceiling
  const withHeadroom = (gas * 120n) / 100n;
  const capped =
    withHeadroom > BigInt(fallbackGasLimit)
      ? BigInt(fallbackGasLimit)
      : withHeadroom;
  return {
    ok: true,
    estimated: true,
    gas_limit: capped.toString(),
    eth_estimate: gas.toString(),
  };
}

/**
 * Compare estimated fee to trade size. Never auto-raises trade budget.
 */
export function evaluateEthereumGasEconomics({
  gasPriceWei,
  gasLimit,
  tradeAmountRaw = 1_000_000n,
  ethUsdHint = null,
  disproportionateRatio = 1n, // fee_usd >= trade_usd → NO-GO suggestion
}) {
  const gp = BigInt(gasPriceWei);
  const gl = BigInt(gasLimit);
  const feeWei = gp * gl;
  const feeEth = Number(feeWei) / 1e18;
  const tradeUsdc = Number(tradeAmountRaw) / 1e6;
  const feeUsd = ethUsdHint != null ? feeEth * Number(ethUsdHint) : null;
  const withinCeiling = gp <= GAS_ASSUMPTIONS.ethereum.max_gas_price_wei;
  const withinBudget = feeWei <= GAS_ASSUMPTIONS.max_gas_budget_wei;
  let verdict = "OK";
  if (!withinCeiling) verdict = "GAS_PRICE_ABOVE_CEILING";
  if (!withinBudget) verdict = "GAS_ABOVE_POLICY_BUDGET";
  if (feeUsd != null && feeUsd >= tradeUsdc * Number(disproportionateRatio)) {
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
    note:
      verdict === "GAS_DISPROPORTIONATE_TO_TRADE"
        ? "Report NO-GO; never auto-increase trade size"
        : null,
  };
}
