/**
 * Explicit chain/venue profiles — never mix testnet Tidepool with mainnet 1Click.
 */
import { MAINNET } from "../networks/profiles.mjs";

export const CHAIN_PROFILE = Object.freeze({
  SEPOLIA_TIDEPOOL: "sepolia_tidepool",
  ARB_SEPOLIA_TIDEPOOL: "arb_sepolia_tidepool",
  BASE_SEPOLIA_TIDEPOOL: "base_sepolia_tidepool",
  MAINNET_1CLICK: "mainnet_1click",
});

export const SEPOLIA_TIDEPOOL = Object.freeze({
  id: CHAIN_PROFILE.SEPOLIA_TIDEPOOL,
  network: "testnet",
  evm_chain_id: 11155111,
  token_usdc: "0x2e6AD9E6D59bB4585ea0E6762c3b637dde29DAD2",
  origin_asset:
    "nep141:eth-0x2e6ad9e6d59bb4585ea0e6762c3b637dde29dad2.tp-omft.testnet",
  destination_asset: "nep141:wnear.tidepool-sandbox.testnet",
  settle_api_base: process.env.TIDEPOOL_URL || "https://www.usetidepool.tech",
  explorer_tx: (hash) => `https://sepolia.etherscan.io/tx/${hash}`,
  funded_sign_env: "GATE_K_ALLOW_SIGN",
  allows_funded: true, // still gated by GATE_K_ALLOW_SIGN externally
});

/** Tidepool Arbitrum Sepolia — distinct from mainnet 42161. */
export const ARB_SEPOLIA_TIDEPOOL = Object.freeze({
  id: CHAIN_PROFILE.ARB_SEPOLIA_TIDEPOOL,
  network: "testnet",
  evm_chain_id: 421614,
  token_usdc: "0x38d81431B9f76d9699AF7517040D5221D9dEA252",
  origin_asset:
    "nep141:arb-0x38d81431b9f76d9699af7517040d5221d9dea252.tp-omft.testnet",
  destination_asset: "nep141:wnear.tidepool-sandbox.testnet",
  settle_api_base: process.env.TIDEPOOL_URL || "https://www.usetidepool.tech",
  explorer_tx: (hash) => `https://sepolia.arbiscan.io/tx/${hash}`,
  funded_sign_env: "GATE_K_ALLOW_SIGN",
  allows_funded: false, // policy/MPC chain-id binding not proven for Arb Sepolia
  note: "Quotes allowed; funded ERC-20 MPC path requires explicit testnet chain-id support",
});

/** Tidepool Base Sepolia — distinct from mainnet 8453. */
export const BASE_SEPOLIA_TIDEPOOL = Object.freeze({
  id: CHAIN_PROFILE.BASE_SEPOLIA_TIDEPOOL,
  network: "testnet",
  evm_chain_id: 84532,
  token_usdc: "0x38d81431B9f76d9699AF7517040D5221D9dEA252",
  origin_asset:
    "nep141:base-0x38d81431b9f76d9699af7517040d5221d9dea252.tp-omft.testnet",
  destination_asset: "nep141:wnear.tidepool-sandbox.testnet",
  settle_api_base: process.env.TIDEPOOL_URL || "https://www.usetidepool.tech",
  explorer_tx: (hash) => `https://sepolia.basescan.org/tx/${hash}`,
  funded_sign_env: "GATE_K_ALLOW_SIGN",
  allows_funded: false,
  note: "Quotes allowed; funded ERC-20 MPC path requires explicit testnet chain-id support",
});

export const MAINNET_1CLICK = Object.freeze({
  id: CHAIN_PROFILE.MAINNET_1CLICK,
  network: "mainnet",
  evm_chain_id: Number(MAINNET.evm.chainId || 42161),
  token_usdc: MAINNET.evm.usdc,
  origin_asset: MAINNET.intents.exampleOriginAsset,
  destination_asset: MAINNET.intents.exampleDestAsset,
  settle_api_base: MAINNET.intents.apiBase,
  explorer_tx: (hash) => `https://arbiscan.io/tx/${hash}`,
  funded_sign_env: "NIO_MAINNET_ALLOW_SIGN",
  allows_funded: false, // hard: journal path must still refuse until gates + deposit bind
});

export function resolveChainProfile(idOrEnv) {
  const raw = String(
    idOrEnv ||
      process.env.NIO_EXECUTION_PROFILE ||
      (process.env.NIO_NETWORK === "mainnet" ? CHAIN_PROFILE.MAINNET_1CLICK : CHAIN_PROFILE.SEPOLIA_TIDEPOOL)
  )
    .trim()
    .toLowerCase();
  if (raw === CHAIN_PROFILE.MAINNET_1CLICK || raw === "mainnet") {
    return MAINNET_1CLICK;
  }
  if (raw === CHAIN_PROFILE.SEPOLIA_TIDEPOOL || raw === "testnet" || raw === "sepolia") {
    return SEPOLIA_TIDEPOOL;
  }
  if (raw === CHAIN_PROFILE.ARB_SEPOLIA_TIDEPOOL || raw === "arb-sepolia") {
    return ARB_SEPOLIA_TIDEPOOL;
  }
  if (raw === CHAIN_PROFILE.BASE_SEPOLIA_TIDEPOOL || raw === "base-sepolia") {
    return BASE_SEPOLIA_TIDEPOOL;
  }
  throw new Error(`unknown_chain_profile:${raw}`);
}

/** Reject cross-contamination of assets / settle endpoints. */
export function assertProfileIsolation(profile, { token, originAsset, settleBase, chainId } = {}) {
  if (!profile?.id) throw new Error("profile_required");
  if (token && String(token).toLowerCase() !== String(profile.token_usdc).toLowerCase()) {
    throw new Error(`token_profile_mismatch:${profile.id}`);
  }
  if (originAsset && String(originAsset) !== String(profile.origin_asset)) {
    // allow only exact profile origin for funded paths
    throw new Error(`origin_asset_profile_mismatch:${profile.id}`);
  }
  if (settleBase) {
    const a = String(settleBase).replace(/\/$/, "");
    const b = String(profile.settle_api_base).replace(/\/$/, "");
    if (a !== b) throw new Error(`settle_endpoint_profile_mismatch:${profile.id}`);
  }
  if (chainId != null && Number(chainId) !== Number(profile.evm_chain_id)) {
    throw new Error(`chain_id_profile_mismatch:${profile.id}`);
  }
  // Hard bans
  if (profile.network === "mainnet") {
    if (String(token || "").toLowerCase().includes("2e6ad9e6d59bb4585ea0e6762c3b637dde29dad2")) {
      throw new Error("sepolia_token_forbidden_on_mainnet");
    }
    if (String(settleBase || "").includes("usetidepool")) {
      throw new Error("tidepool_forbidden_on_mainnet");
    }
    if (String(originAsset || "").includes("tp-omft.testnet")) {
      throw new Error("testnet_asset_forbidden_on_mainnet");
    }
  }
  return true;
}

export function assertMainnetFundedAllowed(
  profile,
  { journal, depositBound, allowSign, canaryUnlock, canary } = {}
) {
  if (profile.id !== CHAIN_PROFILE.MAINNET_1CLICK) return { ok: true };

  const unlock = canaryUnlock || canary || null;
  const modeOk =
    unlock?.mode === "one_shot_canary" ||
    unlock?.mode === "one_shot_canary_recovery" ||
    unlock?.mode === "one_shot_canary_signed_recovery";
  // Signed-recovery forbids request_signature; broadcast still allowed when allows_broadcast.
  const signOk =
    unlock?.allows_broadcast === true &&
    (unlock?.allows_sign === true ||
      unlock?.mode === "one_shot_canary_signed_recovery");
  const canaryOk =
    unlock?.ok === true &&
    modeOk &&
    signOk &&
    unlock?.allows_broadcast === true &&
    unlock?.autonomous_execution_enabled !== true;

  // Env flags alone never unlock mainnet funded path (J3). Canary is the only scoped unlock.
  if (!canaryOk) {
    if (process.env.NIO_MAINNET_ALLOW_SIGN !== "1" && !allowSign) {
      return { ok: false, reason: "mainnet_sign_disabled" };
    }
    if (process.env.NIO_MAINNET_ALLOW_BROADCAST !== "1") {
      return { ok: false, reason: "mainnet_broadcast_disabled" };
    }
    if (process.env.NIO_MAINNET_ALLOW_FUNDED_QUOTE !== "1") {
      return { ok: false, reason: "mainnet_funded_quote_disabled" };
    }
  }

  if (!journal?.assertWritable) {
    return { ok: false, reason: "journal_required_for_mainnet_funded" };
  }
  try {
    journal.assertWritable();
  } catch (e) {
    return { ok: false, reason: "journal_unwritable", detail: String(e.message || e) };
  }
  if (!depositBound?.deposit_address || !depositBound?.binding_ok) {
    return { ok: false, reason: "deposit_binding_required" };
  }
  if (canaryOk) {
    return {
      ok: true,
      mode: unlock.mode,
      operation_id: unlock.operation_id,
      is_recovery:
        unlock.mode === "one_shot_canary_recovery" ||
        unlock.mode === "one_shot_canary_signed_recovery",
      is_signed_recovery: unlock.mode === "one_shot_canary_signed_recovery",
      note: "Scoped canary unlock — not a permanent funded-path enable",
    };
  }
  if (profile.allows_funded === false && process.env.NIO_MAINNET_FUNDED_UNLOCK !== "1") {
    return { ok: false, reason: "mainnet_funded_path_locked" };
  }
  return { ok: false, reason: "mainnet_funded_still_gated" };
}
