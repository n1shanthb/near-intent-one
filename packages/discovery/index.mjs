/**
 * Token discovery abstraction — DISCOVERED ≠ executable.
 * Sources return candidates with freshness; pipeline stages are explicit.
 */
import { PIPELINE_STAGE, parseAssetId, CHAINS } from "../mandate/schema.mjs";

export function createDiscoveryHub(sources = []) {
  return {
    async discover({ chains, query = null, limit = 50 } = {}) {
      const out = [];
      const now = Date.now();
      for (const src of sources) {
        const batch = await src.discover({ chains, query, limit });
        for (const c of batch || []) {
          out.push({
            ...c,
            stage: "DISCOVERED",
            discovered_at: c.discovered_at || new Date(now).toISOString(),
            source: src.id,
          });
        }
      }
      // Deduplicate by asset id
      const map = new Map();
      for (const c of out) {
        if (!c.asset_id) continue;
        if (!map.has(c.asset_id)) map.set(c.asset_id, c);
      }
      return [...map.values()].slice(0, limit);
    },
  };
}

/** Static verified registry sample — not the full universe. */
export function createStaticRegistrySource(tokens) {
  return {
    id: "static_registry",
    async discover({ chains, query, limit }) {
      const q = String(query || "").toLowerCase();
      return (tokens || [])
        .filter((t) => !chains?.length || chains.includes(t.chain))
        .filter(
          (t) =>
            !q ||
            String(t.symbol || "")
              .toLowerCase()
              .includes(q) ||
            String(t.asset_id || "")
              .toLowerCase()
              .includes(q)
        )
        .slice(0, limit)
        .map((t) => ({
          asset_id: t.asset_id,
          symbol: t.symbol || null,
          decimals: t.decimals ?? null,
          chain: t.chain,
          metadata: t.metadata || {},
        }));
    },
  };
}

/** Advance a candidate one pipeline stage with a gate result. */
export function advanceStage(candidate, nextStage, gate) {
  if (!PIPELINE_STAGE.includes(nextStage)) {
    throw new Error(`invalid_stage:${nextStage}`);
  }
  const curIdx = PIPELINE_STAGE.indexOf(candidate.stage || "DISCOVERED");
  const nextIdx = PIPELINE_STAGE.indexOf(nextStage);
  if (nextIdx < curIdx) {
    return { ...candidate, stage: candidate.stage, gate_note: "no_regress" };
  }
  if (!gate?.ok) {
    return {
      ...candidate,
      stage: candidate.stage,
      blocked_at: nextStage,
      block_reason: gate?.reason || "gate_failed",
    };
  }
  return {
    ...candidate,
    stage: nextStage,
    gates: [...(candidate.gates || []), { stage: nextStage, ...gate }],
  };
}

export function shortlistForLlm(candidates, { max = 12 } = {}) {
  return (candidates || [])
    .filter((c) =>
      ["RISK_CHECKED", "QUOTEABLE", "MANDATE_ALLOWED", "ECONOMICALLY_VIABLE"].includes(
        c.stage
      )
    )
    .slice(0, max)
    .map((c) => ({
      asset_id: c.asset_id,
      symbol: c.symbol,
      chain: c.chain,
      stage: c.stage,
      liquidity_hint: c.liquidity_hint || null,
    }));
}

export function verifiedMainnetSeedTokens() {
  // Canonical identities — not a claim of live balances or routes.
  return [
    {
      asset_id: "native:near",
      symbol: "NEAR",
      decimals: 24,
      chain: CHAINS.NEAR.id,
    },
    {
      asset_id: "nep141:wrap.near",
      symbol: "wNEAR",
      decimals: 24,
      chain: CHAINS.NEAR.id,
    },
    {
      asset_id: "eip155:1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      symbol: "USDC",
      decimals: 6,
      chain: CHAINS.ETHEREUM.id,
    },
    {
      asset_id: "eip155:42161:0xaf88d065e77c8cc2239327c5edb3a432268e5831",
      symbol: "USDC",
      decimals: 6,
      chain: CHAINS.ARBITRUM.id,
    },
    {
      asset_id: "eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      symbol: "USDC",
      decimals: 6,
      chain: CHAINS.BASE.id,
    },
    {
      asset_id: "native:eip155:1",
      symbol: "ETH",
      decimals: 18,
      chain: CHAINS.ETHEREUM.id,
    },
    {
      asset_id: "native:eip155:42161",
      symbol: "ETH",
      decimals: 18,
      chain: CHAINS.ARBITRUM.id,
    },
    {
      asset_id: "native:eip155:8453",
      symbol: "ETH",
      decimals: 18,
      chain: CHAINS.BASE.id,
    },
  ].map((t) => {
    parseAssetId(t.asset_id); // validate shape
    return t;
  });
}
