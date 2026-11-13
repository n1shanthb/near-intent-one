/**
 * Multichain canary route profiles — independent of J8B Arb→Base constants.
 * Profiles select verified chain/asset bindings; they never unlock funded execution alone.
 */
import { MAINNET_IDENTITIES, MAINNET_USDC, MAINNET_EVM_RPCS } from "./identities.mjs";
import { ASSETS } from "./quotePath.mjs";
import { GAS_ASSUMPTIONS } from "./j5_2.quoteScan.mjs";

/** Native USDC on NEAR (NEP-141) — not wrap.near, not an intents balance id. */
export const NEAR_NATIVE_USDC_CONTRACT =
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const NEAR_NATIVE_USDC_ASSET = `nep141:${NEAR_NATIVE_USDC_CONTRACT}`;

export const ROUTE_IDS = Object.freeze({
  J8B_ARB_BASE: "j8b_arb_usdc_to_base_usdc",
  M1_ETH_NEAR_USDC: "m1_eth_usdc_to_near_usdc",
  M2_BASE_ETH_USDC: "m2_base_usdc_to_eth_usdc",
});

/**
 * Canonical route profile shape used by dry-run / future executors.
 */
export function buildRouteProfile(partial) {
  const p = { ...partial };
  for (const k of [
    "id",
    "source_chain",
    "source_chain_id",
    "source_token",
    "asset_in",
    "destination_chain",
    "asset_out",
    "recipient",
    "refund_to",
    "amount",
    "decimals_in",
    "decimals_out",
  ]) {
    if (p[k] == null || p[k] === "") {
      throw new Error(`route_profile_missing:${k}`);
    }
  }
  if (Number(p.decimals_in) !== Number(p.decimals_out)) {
    p.decimals_risk = "CROSS_DECIMAL";
  } else {
    p.decimals_risk = "SAFE_SAME_DECIMALS";
  }
  return Object.freeze(p);
}

/** Mission 1 — Ethereum mainnet native USDC → NEAR NEP-141 USDC. */
export const M1_ETH_NEAR_USDC = buildRouteProfile({
  id: ROUTE_IDS.M1_ETH_NEAR_USDC,
  label: "Ethereum USDC → NEAR USDC",
  source_chain: "ethereum",
  source_chain_id: 1,
  source_eip155: "eip155:1",
  source_rpc: MAINNET_EVM_RPCS.ethereum,
  source_token: MAINNET_USDC.ethereum.toLowerCase(),
  asset_in: ASSETS.eth_usdc.asset_id,
  destination_chain: "near",
  destination_kind: "nep141",
  destination_contract: NEAR_NATIVE_USDC_CONTRACT,
  asset_out: NEAR_NATIVE_USDC_ASSET,
  /** Explicitly NOT wrap.near and NOT an intents internal balance. */
  not_assets: Object.freeze(["nep141:wrap.near", "native:near"]),
  recipient: MAINNET_IDENTITIES.owner,
  recipient_type: "DESTINATION_CHAIN",
  refund_to: MAINNET_IDENTITIES.mpc_evm_address.toLowerCase(),
  refund_type: "ORIGIN_CHAIN",
  signer_mpc: MAINNET_IDENTITIES.mpc_evm_address.toLowerCase(),
  amount: "1000000",
  amount_label: "1 USDC",
  decimals_in: 6,
  decimals_out: 6,
  /** Stricter than policy max (100); required for 1 USDC min_out to clear floor. */
  quote_slippage_bps: 50,
  policy_max_slippage_bps: 100,
  gas_limit_ceiling: String(GAS_ASSUMPTIONS.gas_limit),
  max_gas_price_wei: String(GAS_ASSUMPTIONS.ethereum.max_gas_price_wei),
  explorer_tx: (hash) => `https://etherscan.io/tx/${hash}`,
  settlement: Object.freeze({
    source: "evm_erc20_transfer",
    destination: "near_nep141_ft_delta",
  }),
});

/** Mission 2 stub — Base → Ethereum USDC (not executed until Mission 1 done). */
export const M2_BASE_ETH_USDC = buildRouteProfile({
  id: ROUTE_IDS.M2_BASE_ETH_USDC,
  label: "Base USDC → Ethereum USDC",
  source_chain: "base",
  source_chain_id: 8453,
  source_eip155: "eip155:8453",
  source_rpc: MAINNET_EVM_RPCS.base,
  source_token: MAINNET_USDC.base.toLowerCase(),
  asset_in:
    "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  destination_chain: "ethereum",
  destination_kind: "evm_erc20",
  destination_contract: MAINNET_USDC.ethereum.toLowerCase(),
  asset_out: ASSETS.eth_usdc.asset_id,
  recipient: MAINNET_IDENTITIES.mpc_evm_address.toLowerCase(),
  recipient_type: "DESTINATION_CHAIN",
  refund_to: MAINNET_IDENTITIES.mpc_evm_address.toLowerCase(),
  refund_type: "ORIGIN_CHAIN",
  signer_mpc: MAINNET_IDENTITIES.mpc_evm_address.toLowerCase(),
  amount: "1000000",
  amount_label: "1 USDC",
  decimals_in: 6,
  decimals_out: 6,
  quote_slippage_bps: 50,
  policy_max_slippage_bps: 100,
  gas_limit_ceiling: String(GAS_ASSUMPTIONS.gas_limit),
  max_gas_price_wei: String(GAS_ASSUMPTIONS.base.max_gas_price_wei),
  explorer_tx: (hash) => `https://basescan.org/tx/${hash}`,
  settlement: Object.freeze({
    source: "evm_erc20_transfer",
    destination: "evm_erc20_delta",
  }),
});

export function resolveCanaryRouteProfile(id) {
  const key = String(id || "").trim().toLowerCase();
  if (key === ROUTE_IDS.M1_ETH_NEAR_USDC || key === "m1" || key === "eth-near") {
    return M1_ETH_NEAR_USDC;
  }
  if (key === ROUTE_IDS.M2_BASE_ETH_USDC || key === "m2" || key === "base-eth") {
    return M2_BASE_ETH_USDC;
  }
  throw new Error(`unknown_canary_route:${id}`);
}

/** Reject accidental reuse of J8B Arb/Base bindings on Mission 1. */
export function assertNotJ8bRoute(profile) {
  if (Number(profile.source_chain_id) === 42161) {
    throw new Error("j8b_arb_route_forbidden_for_mission");
  }
  if (String(profile.asset_out || "").includes("base-0x833589")) {
    throw new Error("j8b_base_dest_forbidden_for_mission");
  }
  return true;
}

export function assertRouteAssetIsolation(profile, { token, assetIn, assetOut, chainId } = {}) {
  assertNotJ8bRoute(profile);
  if (token && String(token).toLowerCase() !== String(profile.source_token).toLowerCase()) {
    throw new Error(`route_token_mismatch:${profile.id}`);
  }
  if (assetIn && String(assetIn) !== String(profile.asset_in)) {
    throw new Error(`route_asset_in_mismatch:${profile.id}`);
  }
  if (assetOut && String(assetOut) !== String(profile.asset_out)) {
    throw new Error(`route_asset_out_mismatch:${profile.id}`);
  }
  if (chainId != null && Number(chainId) !== Number(profile.source_chain_id)) {
    throw new Error(`route_chain_id_mismatch:${profile.id}`);
  }
  for (const banned of profile.not_assets || []) {
    if (assetOut && String(assetOut) === String(banned)) {
      throw new Error(`banned_destination_asset:${banned}`);
    }
  }
  return true;
}
