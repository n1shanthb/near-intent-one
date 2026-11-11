/**
 * Owner mandate schema — ANY_ELIGIBLE_TOKEN vs ALLOWLIST.
 * Default is ALWAYS allowlist. Broad discretion must be explicit.
 */

export const TOKEN_SCOPE = Object.freeze({
  ALLOWLIST: "allowlist",
  ANY_ELIGIBLE_TOKEN: "any_eligible_token",
});

/** Canonical chain IDs for NIO mainnet portfolio. */
export const CHAINS = Object.freeze({
  NEAR: { id: "near", label: "NEAR", kind: "near", caip2: "near:mainnet" },
  ETHEREUM: {
    id: "eip155:1",
    label: "Ethereum",
    kind: "evm",
    chainId: 1,
    caip2: "eip155:1",
  },
  ARBITRUM: {
    id: "eip155:42161",
    label: "Arbitrum",
    kind: "evm",
    chainId: 42161,
    caip2: "eip155:42161",
  },
  BASE: {
    id: "eip155:8453",
    label: "Base",
    kind: "evm",
    chainId: 8453,
    caip2: "eip155:8453",
  },
});

export const VENUES = Object.freeze({
  NEAR_INTENTS_1CLICK: "near_intents_1click",
  EVM_0X: "evm_0x",
  NEAR_NATIVE_DEX: "near_native_dex",
});

export const PIPELINE_STAGE = Object.freeze([
  "DISCOVERED",
  "RESEARCHED",
  "RISK_CHECKED",
  "QUOTEABLE",
  "MANDATE_ALLOWED",
  "ECONOMICALLY_VIABLE",
  "APPROVED_FOR_EXECUTION",
]);

/** Build a chain-specific asset identity — never symbols alone. */
export function assetId({ chain, kind, address, nearAccount }) {
  if (kind === "native" && chain === "near") return "native:near";
  if (kind === "native" && String(chain).startsWith("eip155:")) {
    return `native:${chain}`;
  }
  if (kind === "nep141") {
    if (!nearAccount) throw new Error("nep141_requires_account");
    return `nep141:${nearAccount}`;
  }
  if (kind === "erc20") {
    const c = String(chain);
    const a = String(address || "").toLowerCase();
    if (!c.startsWith("eip155:")) throw new Error("erc20_requires_eip155_chain");
    if (!/^0x[a-f0-9]{40}$/.test(a)) throw new Error("bad_erc20_address");
    return `${c}:${a}`;
  }
  throw new Error("unsupported_asset_kind");
}

export function parseAssetId(id) {
  const s = String(id || "");
  if (s === "native:near") return { kind: "native", chain: "near" };
  if (s.startsWith("native:eip155:")) {
    return { kind: "native", chain: s.slice("native:".length) };
  }
  if (s.startsWith("nep141:")) {
    return { kind: "nep141", chain: "near", nearAccount: s.slice(7) };
  }
  const m = s.match(/^(eip155:\d+):(0x[a-fA-F0-9]{40})$/);
  if (m) {
    return { kind: "erc20", chain: m[1], address: m[2].toLowerCase() };
  }
  // Legacy OMFT / symbol forms — not valid for new mandates
  return { kind: "legacy_or_unknown", raw: s };
}

export function chainOfAsset(id) {
  const p = parseAssetId(id);
  if (p.chain) return p.chain;
  if (p.kind === "legacy_or_unknown" && String(id).includes(".near")) return "near";
  return null;
}

/**
 * @returns {{ ok: true, mandate } | { ok: false, reasons: string[] }}
 */
export function validateMandate(input) {
  const reasons = [];
  const token_scope = String(input.token_scope || TOKEN_SCOPE.ALLOWLIST);
  if (
    token_scope !== TOKEN_SCOPE.ALLOWLIST &&
    token_scope !== TOKEN_SCOPE.ANY_ELIGIBLE_TOKEN
  ) {
    reasons.push("invalid_token_scope");
  }
  const allowed_chains = [...(input.allowed_chains || [])];
  if (!allowed_chains.length) reasons.push("allowed_chains_required");

  const allowed_assets = [...(input.allowed_assets || [])];
  const allowed_assets_out = [...(input.allowed_assets_out || allowed_assets)];

  if (token_scope === TOKEN_SCOPE.ALLOWLIST) {
    if (!allowed_assets.length) reasons.push("allowlist_requires_assets");
    for (const a of allowed_assets) {
      const p = parseAssetId(a);
      if (p.kind === "legacy_or_unknown") {
        reasons.push(`asset_not_canonical:${a}`);
      }
    }
  }
  if (token_scope === TOKEN_SCOPE.ANY_ELIGIBLE_TOKEN) {
    if (input.explicit_any_token_authorization !== true) {
      reasons.push("any_token_requires_explicit_owner_authorization");
    }
  }

  const mandate = {
    token_scope,
    allowed_chains,
    allowed_assets,
    allowed_assets_out,
    allowed_venues: [...(input.allowed_venues || [VENUES.NEAR_INTENTS_1CLICK])],
    max_trade_value: String(input.max_trade_value || "0"),
    daily_turnover_limit: String(input.daily_turnover_limit || "0"),
    max_pending_exposure: String(input.max_pending_exposure || "0"),
    max_gas_budget: String(input.max_gas_budget || "0"),
    max_slippage_bps: Number(input.max_slippage_bps || 0),
    valid_until: String(input.valid_until || "0"),
    allocation_budget: String(input.allocation_budget || "0"),
  };

  if (reasons.length) return { ok: false, reasons };
  return { ok: true, mandate };
}

export function assetAllowedByMandate(mandate, assetId, { direction = "in" } = {}) {
  const list =
    direction === "out"
      ? mandate.allowed_assets_out || mandate.allowed_assets
      : mandate.allowed_assets;
  if (mandate.token_scope === TOKEN_SCOPE.ALLOWLIST) {
    return list.includes(assetId);
  }
  if (mandate.token_scope === TOKEN_SCOPE.ANY_ELIGIBLE_TOKEN) {
    const chain = chainOfAsset(assetId);
    return Boolean(chain && mandate.allowed_chains.includes(chain));
  }
  return false;
}
