/**
 * Four-chain NIO portfolio model — identities are canonical, not symbols.
 * Balances/routes stay unverified until Chat 1 / live reads supply proof.
 */

export type NioChainId = "near" | "eip155:1" | "eip155:42161" | "eip155:8453";

export type ChainDef = {
  id: NioChainId;
  label: string;
  short: string;
  kind: "near" | "evm";
  evmChainId?: number;
  gasAsset: string;
  explorerAccount: (id: string) => string;
  explorerTx: (hash: string) => string;
  /** Verification status for UI — never claim LIVE without evidence. */
  status: "awaiting_evidence" | "partial" | "verified";
};

export const NIO_CHAINS: ChainDef[] = [
  {
    id: "near",
    label: "NEAR",
    short: "NEAR",
    kind: "near",
    gasAsset: "native:near",
    explorerAccount: (id) => `https://nearblocks.io/address/${id}`,
    explorerTx: (hash) => `https://nearblocks.io/txns/${hash}`,
    status: "awaiting_evidence",
  },
  {
    id: "eip155:42161",
    label: "Arbitrum One",
    short: "Arbitrum",
    kind: "evm",
    evmChainId: 42161,
    gasAsset: "native:eip155:42161",
    explorerAccount: (id) => `https://arbiscan.io/address/${id}`,
    explorerTx: (hash) => `https://arbiscan.io/tx/${hash}`,
    status: "awaiting_evidence",
  },
  {
    id: "eip155:8453",
    label: "Base",
    short: "Base",
    kind: "evm",
    evmChainId: 8453,
    gasAsset: "native:eip155:8453",
    explorerAccount: (id) => `https://basescan.org/address/${id}`,
    explorerTx: (hash) => `https://basescan.org/tx/${hash}`,
    status: "awaiting_evidence",
  },
  {
    id: "eip155:1",
    label: "Ethereum",
    short: "Ethereum",
    kind: "evm",
    evmChainId: 1,
    gasAsset: "native:eip155:1",
    explorerAccount: (id) => `https://etherscan.io/address/${id}`,
    explorerTx: (hash) => `https://etherscan.io/tx/${hash}`,
    status: "awaiting_evidence",
  },
];

/** Verified token identities for selectors — not live balances. */
export const VERIFIED_TOKEN_OPTIONS = [
  {
    asset_id: "native:near",
    symbol: "NEAR",
    chain: "near" as NioChainId,
    decimals: 24,
  },
  {
    asset_id: "nep141:wrap.near",
    symbol: "wNEAR",
    chain: "near" as NioChainId,
    decimals: 24,
  },
  {
    asset_id: "eip155:1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    symbol: "USDC",
    chain: "eip155:1" as NioChainId,
    decimals: 6,
  },
  {
    asset_id: "eip155:42161:0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    symbol: "USDC",
    chain: "eip155:42161" as NioChainId,
    decimals: 6,
  },
  {
    asset_id: "eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    symbol: "USDC",
    chain: "eip155:8453" as NioChainId,
    decimals: 6,
  },
  {
    asset_id: "native:eip155:1",
    symbol: "ETH",
    chain: "eip155:1" as NioChainId,
    decimals: 18,
  },
  {
    asset_id: "native:eip155:42161",
    symbol: "ETH",
    chain: "eip155:42161" as NioChainId,
    decimals: 18,
  },
  {
    asset_id: "native:eip155:8453",
    symbol: "ETH",
    chain: "eip155:8453" as NioChainId,
    decimals: 18,
  },
] as const;

export type PortfolioPosition = {
  chain: NioChainId;
  asset_id: string;
  symbol: string;
  balance: string | null;
  decimals: number;
  usd: number | null;
  valuation_source: string | null;
  custody: string | null;
  pending: boolean;
  gas_reserve: boolean;
  risk_status: "unknown" | "cleared" | "blocked";
  verified: boolean;
};

/** Empty four-chain scaffold — no fake balances. */
export function emptyFourChainPositions(): PortfolioPosition[] {
  return NIO_CHAINS.flatMap((c) => {
    const gas = VERIFIED_TOKEN_OPTIONS.find((t) => t.asset_id === c.gasAsset);
    return [
      {
        chain: c.id,
        asset_id: c.gasAsset,
        symbol: gas?.symbol || "GAS",
        balance: null,
        decimals: gas?.decimals ?? 18,
        usd: null,
        valuation_source: null,
        custody: null,
        pending: false,
        gas_reserve: true,
        risk_status: "unknown",
        verified: false,
      },
    ];
  });
}

export function chainLabel(id: string): string {
  return NIO_CHAINS.find((c) => c.id === id)?.label || id;
}
