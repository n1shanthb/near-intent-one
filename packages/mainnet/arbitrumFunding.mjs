/**
 * Arbitrum One funding prep helpers for Checkpoint J7A.
 * Read-only: balances, gas, NodeInterface L1 component. Never broadcasts.
 */
import { keccak_256 } from "@noble/hashes/sha3";
import { MAINNET_EVM_RPCS, MAINNET_USDC } from "./identities.mjs";

export const ARBITRUM_CHAIN_ID = 42161;
export const ARBITRUM_NATIVE_USDC =
  MAINNET_USDC.arbitrum.toLowerCase();
/** Bridged USDC.e — must NOT be used for the first test. */
export const ARBITRUM_USDC_E =
  "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8";
export const ARBITRUM_NODE_INTERFACE =
  "0x00000000000000000000000000000000000000c8";

/** Attestor / QUOTE_AUTH_V2 gas ceiling used in J6A local attest. */
export const ATTESTOR_MAX_GAS_PRICE_WEI = 100_000_000n; // 0.1 gwei
export const ATTESTOR_GAS_LIMIT = 250_000n;

async function ethRpc(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

function padAddress(addr) {
  return String(addr || "")
    .replace(/^0x/i, "")
    .toLowerCase()
    .padStart(64, "0");
}

function decodeAbiString(hex) {
  if (!hex || hex === "0x") return null;
  const b = Buffer.from(hex.slice(2), "hex");
  if (b.length < 64) return null;
  const len = Number(BigInt("0x" + b.subarray(32, 64).toString("hex")));
  return b.subarray(64, 64 + len).toString("utf8");
}

export function buildErc20TransferData(to, amountRaw) {
  const amt = BigInt(amountRaw).toString(16).padStart(64, "0");
  return "0xa9059cbb" + padAddress(to) + amt;
}

export async function arbitrumChainId(rpcUrl) {
  const j = await ethRpc(rpcUrl, "eth_chainId", []);
  if (j.error) return { ok: false, reason: j.error.message };
  const id = Number(BigInt(j.result));
  return {
    ok: id === ARBITRUM_CHAIN_ID,
    chain_id: id,
    expected: ARBITRUM_CHAIN_ID,
  };
}

export async function readTokenMeta(rpcUrl, token) {
  const [sym, name, dec] = await Promise.all([
    ethRpc(rpcUrl, "eth_call", [{ to: token, data: "0x95d89b41" }, "latest"]),
    ethRpc(rpcUrl, "eth_call", [{ to: token, data: "0x06fdde03" }, "latest"]),
    ethRpc(rpcUrl, "eth_call", [{ to: token, data: "0x313ce567" }, "latest"]),
  ]);
  return {
    token: token.toLowerCase(),
    symbol: decodeAbiString(sym.result),
    name: decodeAbiString(name.result),
    decimals: Number(BigInt(dec.result || "0x0")),
  };
}

export async function nodeInterfaceL1Component(
  rpcUrl,
  { to, data, from }
) {
  const sel = Buffer.from(
    keccak_256(Buffer.from("gasEstimateL1Component(address,bool,bytes)"))
  )
    .subarray(0, 4)
    .toString("hex");
  const dataBytes = String(data).replace(/^0x/i, "");
  const callData =
    "0x" +
    sel +
    padAddress(to) +
    "0".repeat(64) + // contractCreation=false
    (96).toString(16).padStart(64, "0") +
    (dataBytes.length / 2).toString(16).padStart(64, "0") +
    dataBytes +
    "0".repeat((64 - (dataBytes.length % 64)) % 64);

  const j = await ethRpc(rpcUrl, "eth_call", [
    { to: ARBITRUM_NODE_INTERFACE, data: callData, from },
    "latest",
  ]);
  if (j.error || !j.result || j.result === "0x") {
    return { ok: false, reason: j.error?.message || "l1_component_failed" };
  }
  const h = j.result.slice(2);
  const gasEstimateForL1 = Number(BigInt("0x" + h.slice(0, 64)));
  const baseFee = BigInt("0x" + h.slice(64, 128));
  const l1BaseFeeEstimate = BigInt("0x" + h.slice(128, 192));
  return {
    ok: true,
    gas_estimate_for_l1: gasEstimateForL1,
    base_fee_wei: baseFee.toString(),
    l1_base_fee_estimate_wei: l1BaseFeeEstimate.toString(),
    l1_component_fee_wei: (BigInt(gasEstimateForL1) * baseFee).toString(),
  };
}

/**
 * Estimate gas for a 1-USDC ERC-20 transfer.
 * If `from` has insufficient balance, falls back to a recent successful
 * on-chain native-USDC transfer gasUsed + eth_estimateGas from that sender.
 */
export async function estimateErc20TransferGas(
  rpcUrl,
  { from, token, to, amountRaw }
) {
  const data = buildErc20TransferData(to, amountRaw);
  const direct = await ethRpc(rpcUrl, "eth_estimateGas", [
    { from, to: token, data },
  ]);
  if (direct.result) {
    return {
      ok: true,
      method: "eth_estimateGas_from_mpc",
      gas: Number(BigInt(direct.result)),
      data,
    };
  }

  // Scan recent blocks for a successful native-USDC transfer; reuse sender.
  const blockHex = (await ethRpc(rpcUrl, "eth_blockNumber", [])).result;
  const blockNum = BigInt(blockHex);
  const tokenLc = token.toLowerCase();
  let proxyFrom = null;
  let observedGasUsed = null;
  for (let i = 0; i < 12 && !proxyFrom; i++) {
    const bn = "0x" + (blockNum - BigInt(i)).toString(16);
    const blk = await ethRpc(rpcUrl, "eth_getBlockByNumber", [bn, true]);
    for (const tx of blk.result?.transactions || []) {
      if (
        String(tx.to || "").toLowerCase() === tokenLc &&
        String(tx.input || "").startsWith("0xa9059cbb")
      ) {
        const rcpt = await ethRpc(rpcUrl, "eth_getTransactionReceipt", [
          tx.hash,
        ]);
        if (rcpt.result?.status === "0x1") {
          proxyFrom = tx.from;
          observedGasUsed = Number(BigInt(rcpt.result.gasUsed));
          break;
        }
      }
    }
  }

  if (proxyFrom) {
    const est = await ethRpc(rpcUrl, "eth_estimateGas", [
      { from: proxyFrom, to: token, data },
    ]);
    if (est.result) {
      return {
        ok: true,
        method: "eth_estimateGas_from_funded_holder",
        gas: Number(BigInt(est.result)),
        observed_gas_used_sample: observedGasUsed,
        proxy_from: proxyFrom,
        mpc_estimate_error: direct.error?.message || null,
        data,
      };
    }
  }

  if (observedGasUsed) {
    return {
      ok: true,
      method: "recent_receipt_gasUsed",
      gas: observedGasUsed,
      mpc_estimate_error: direct.error?.message || null,
      data,
    };
  }

  return {
    ok: false,
    reason: "gas_estimate_unavailable",
    detail: direct.error?.message || null,
    data,
  };
}

export async function fetchArbitrumGasPrice(rpcUrl) {
  const j = await ethRpc(rpcUrl, "eth_gasPrice", []);
  if (j.error) return { ok: false, reason: j.error.message };
  const wei = BigInt(j.result);
  return {
    ok: true,
    wei: wei.toString(),
    gwei: Number(wei) / 1e9,
  };
}

/**
 * Fail-closed compatibility of live network vs attestor gas ceiling.
 */
export function evaluateAttestorGasFit({
  liveGasPriceWei,
  estimatedGas,
  maxGasPriceWei = ATTESTOR_MAX_GAS_PRICE_WEI,
  gasLimit = ATTESTOR_GAS_LIMIT,
}) {
  const price = BigInt(liveGasPriceWei);
  const gas = BigInt(estimatedGas);
  const incompatibilities = [];
  if (price > maxGasPriceWei) {
    incompatibilities.push({
      code: "live_gas_price_exceeds_attestor_max_gas_price",
      live: price.toString(),
      max: maxGasPriceWei.toString(),
    });
  }
  if (gas > gasLimit) {
    incompatibilities.push({
      code: "estimated_gas_exceeds_attestor_gas_limit",
      estimated: gas.toString(),
      limit: gasLimit.toString(),
    });
  }
  const worstCaseWei = gasLimit * maxGasPriceWei;
  const liveCaseWei = gas * price;
  return {
    ok: incompatibilities.length === 0,
    executable_under_attestor_bounds: incompatibilities.length === 0,
    incompatibilities,
    live_case_fee_wei: liveCaseWei.toString(),
    attestor_ceiling_fee_wei: worstCaseWei.toString(),
  };
}

/**
 * Conservative minimal ETH funding from measured fees + attestor ceiling.
 * covers: 1 success + 1 retry at attestor ceiling, plus 25% ops margin.
 */
export function recommendEthFunding({
  liveCaseFeeWei,
  attestorCeilingFeeWei,
  successPlusRetry = 2n,
  marginBps = 2500n, // +25%
}) {
  const live = BigInt(liveCaseFeeWei);
  const ceiling = BigInt(attestorCeilingFeeWei);
  const base = ceiling > live ? ceiling : live;
  const withAttempts = base * successPlusRetry;
  const withMargin = withAttempts + (withAttempts * marginBps) / 10000n;
  // Round up to 1e12 wei (0.000001 ETH) for operable transfer granularity
  const quantum = 1_000_000_000_000n;
  const rounded =
    withMargin % quantum === 0n
      ? withMargin
      : withMargin + (quantum - (withMargin % quantum));
  return {
    recommended_wei: rounded.toString(),
    recommended_eth: Number(rounded) / 1e18,
    basis: {
      base_fee_model: "max(live_case, attestor_ceiling) * retries * (1+margin)",
      success_plus_retry: Number(successPlusRetry),
      margin_bps: Number(marginBps),
      live_case_fee_wei: live.toString(),
      attestor_ceiling_fee_wei: ceiling.toString(),
      pre_round_wei: withMargin.toString(),
    },
  };
}

/** Exactly one 1-USDC test + modest remainder (no excess capital). */
export function recommendUsdcFunding() {
  return {
    trade_units: "1000000",
    trade_usdc: 1,
    remainder_units: "1000000",
    remainder_usdc: 1,
    recommended_units: "2000000",
    recommended_usdc: 2,
    token: ARBITRUM_NATIVE_USDC,
    note: "1 USDC for the first test transfer/trade + 1 USDC operational remainder",
  };
}

export function defaultArbRpc() {
  return MAINNET_EVM_RPCS.arbitrum;
}
