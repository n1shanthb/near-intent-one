/**
 * Live 1Click token catalog → four-chain canonical universe.
 * Tokens are identified by assetId + chain + contract — never symbol alone.
 */
import { fetchProductionTokens } from "./intents.mjs";

/** Provider blockchain codes we accept for NIO multichain MVP. */
export const NIO_CHAINS = Object.freeze({
  near: Object.freeze({
    id: "near",
    provider_codes: ["near"],
    eip155: null,
    display: "NEAR",
  }),
  ethereum: Object.freeze({
    id: "ethereum",
    provider_codes: ["eth"],
    eip155: "eip155:1",
    display: "Ethereum",
  }),
  arbitrum: Object.freeze({
    id: "arbitrum",
    provider_codes: ["arb"],
    eip155: "eip155:42161",
    display: "Arbitrum",
  }),
  base: Object.freeze({
    id: "base",
    provider_codes: ["base"],
    eip155: "eip155:8453",
    display: "Base",
  }),
});

const PROVIDER_TO_NIO = new Map();
for (const c of Object.values(NIO_CHAINS)) {
  for (const code of c.provider_codes) PROVIDER_TO_NIO.set(code, c.id);
}

export function mapProviderChain(blockchain) {
  return PROVIDER_TO_NIO.get(String(blockchain || "").toLowerCase()) || null;
}

export function normalizeCatalogToken(raw) {
  const assetId = raw?.assetId || raw?.asset_id || null;
  const providerChain = String(raw?.blockchain || raw?.chain || "").toLowerCase();
  const nioChain = mapProviderChain(providerChain);
  if (!assetId || !nioChain) return null;

  const price =
    raw.price == null || raw.price === "" ? null : Number(raw.price);
  const priceUpdatedAt = raw.priceUpdatedAt || raw.price_updated_at || null;
  const priceAgeMs = priceUpdatedAt ? Date.now() - Date.parse(priceUpdatedAt) : null;
  const pricingFresh =
    price != null &&
    Number.isFinite(price) &&
    price > 0 &&
    priceAgeMs != null &&
    Number.isFinite(priceAgeMs) &&
    priceAgeMs >= 0 &&
    priceAgeMs < 24 * 3600_000;

  return {
    asset_id: String(assetId),
    provider_asset_id: String(assetId),
    origin_network: nioChain,
    provider_blockchain: providerChain,
    eip155: NIO_CHAINS[nioChain].eip155,
    symbol: raw.symbol || null,
    decimals: Number(raw.decimals),
    contract_address: raw.contractAddress || raw.contract_address || null,
    price_usd: pricingFresh ? price : price,
    price_updated_at: priceUpdatedAt,
    price_age_ms: priceAgeMs,
    pricing_fresh: Boolean(pricingFresh),
    // Catalog listing ≠ proven quotable; set after a successful dry quote.
    listed: true,
    quotable: null,
    execution_available: null,
    coingecko_id: raw.coingeckoId || raw.coingecko_id || null,
  };
}

/**
 * Build the four-chain universe from a live (or injected) token list.
 */
export function buildFourChainUniverse(tokenList) {
  const list = Array.isArray(tokenList) ? tokenList : [];
  const assets = [];
  const byAssetId = new Map();
  const byChain = {
    near: [],
    ethereum: [],
    arbitrum: [],
    base: [],
  };

  for (const raw of list) {
    const t = normalizeCatalogToken(raw);
    if (!t) continue;
    if (byAssetId.has(t.asset_id)) continue;
    byAssetId.set(t.asset_id, t);
    assets.push(t);
    byChain[t.origin_network].push(t);
  }

  return {
    ok: true,
    fetched_at: new Date().toISOString(),
    provider: "near_intents_1click",
    chains: Object.keys(byChain),
    counts: {
      total_catalog: list.length,
      four_chain: assets.length,
      near: byChain.near.length,
      ethereum: byChain.ethereum.length,
      arbitrum: byChain.arbitrum.length,
      base: byChain.base.length,
    },
    assets,
    by_asset_id: byAssetId,
    by_chain: byChain,
    note: "listed≠quotable — run dry quotes before claiming execution availability",
  };
}

export async function fetchFourChainCatalog(opts = {}) {
  const tokens = await fetchProductionTokens(opts);
  if (!tokens.ok) {
    return {
      ok: false,
      reason: tokens.reason || "tokens_unavailable",
      detail: tokens,
    };
  }
  const universe = buildFourChainUniverse(tokens.tokens);
  return {
    ...universe,
    ok: true,
    api: tokens.api,
    status_label: tokens.status_label,
  };
}

/** Resolve a token by exact assetId inside a universe. */
export function requireAsset(universe, assetId) {
  const id = String(assetId || "");
  const t = universe?.by_asset_id?.get?.(id) || universe?.by_asset_id?.[id];
  if (!t) return { ok: false, reason: "asset_not_in_four_chain_catalog", asset_id: id };
  return { ok: true, token: t };
}

/**
 * Find USDC / WETH / wNEAR canonical IDs per chain from catalog (by contract, not symbol alone).
 */
export function resolveCanonicalAssets(universe) {
  const find = (chain, pred) =>
    (universe.by_chain[chain] || []).find(pred) || null;

  const arbUsdc = find(
    "arbitrum",
    (t) =>
      String(t.contract_address || "").toLowerCase() ===
      "0xaf88d065e77c8cc2239327c5edb3a432268e5831"
  );
  const baseUsdc = find(
    "base",
    (t) =>
      String(t.contract_address || "").toLowerCase() ===
      "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
  );
  const ethUsdc = find(
    "ethereum",
    (t) =>
      String(t.contract_address || "").toLowerCase() ===
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
  );
  const ethWeth = find(
    "ethereum",
    (t) =>
      String(t.contract_address || "").toLowerCase() ===
      "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
  );
  const wrapNear = find(
    "near",
    (t) => t.asset_id === "nep141:wrap.near" || t.contract_address === "wrap.near"
  );
  const nearUsdc = find(
    "near",
    (t) =>
      t.asset_id ===
        "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" ||
      String(t.contract_address || "") ===
        "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
  );
  const nearUsdt = find(
    "near",
    (t) =>
      t.asset_id === "nep141:usdt.tether-token.near" ||
      t.contract_address === "usdt.tether-token.near"
  );
  const arbWeth = find(
    "arbitrum",
    (t) =>
      String(t.contract_address || "").toLowerCase() ===
      "0x82af49447d8a07e3bd95bd0d56f35241523fbab1"
  );
  const baseWeth = find(
    "base",
    (t) =>
      String(t.contract_address || "").toLowerCase() ===
      "0x4200000000000000000000000000000000000006"
  );

  return {
    arb_usdc: arbUsdc,
    base_usdc: baseUsdc,
    eth_usdc: ethUsdc,
    eth_weth: ethWeth,
    arb_weth: arbWeth,
    base_weth: baseWeth,
    wrap_near: wrapNear,
    near_usdc: nearUsdc,
    near_usdt: nearUsdt,
    complete: Boolean(arbUsdc && baseUsdc && ethUsdc && ethWeth && wrapNear),
  };
}
