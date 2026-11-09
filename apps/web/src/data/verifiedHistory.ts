import { CONFIG } from "../lib/config";

export type TxRecord = {
  id: string;
  gate: string;
  when: string;
  title: string;
  pair: string;
  amountIn: string;
  amountOut: string;
  settlement: "SUCCESS" | "FAILED" | "REJECTED" | "LIMITATION";
  verification: "verified_onchain" | "verified_evidence";
  steps: { label: string; href?: string; detail?: string }[];
  note?: string;
};

/** Real Gate D / E records for cockpit Activity — hashes from EVIDENCE.md */
export const VERIFIED_TRANSACTIONS: TxRecord[] = [
  {
    id: "gated-1794226628602",
    gate: "D",
    when: "2026-11-09T12:15:00Z",
    title: "ORIGIN_CHAIN USDC → wNEAR",
    pair: "Sepolia USDC → Tidepool wNEAR",
    amountIn: "1 USDC (1000000 base)",
    amountOut: "≈0.281057 wNEAR (settled)",
    settlement: "SUCCESS",
    verification: "verified_evidence",
    steps: [
      {
        label: "Policy propose + MPC sign",
        href: `${CONFIG.nearblocks}/txns/APcU7aqXGAGqpGXNcfzC9h37wLaaEiEZQovGm4xUSXn4`,
      },
      {
        label: "Sepolia ERC-20 deposit",
        href: `${CONFIG.etherscan}/tx/0x67fde88c4251a2946b7d2ea172b2015a1d4b6dbfdd0b22d84a94a6d8efe75b6e`,
      },
      {
        label: "Tidepool status SUCCESS",
        detail: "correlationId d3165b6b-d018-46eb-a5d4-e1fda9bf511a",
      },
    ],
  },
  {
    id: "e3-a-1794228257265",
    gate: "E3",
    when: "2026-11-09T12:44:00Z",
    title: "Post-revoke broadcast of pre-signed tx A",
    pair: "0.1 USDC → burn (harmless)",
    amountIn: "0.1 USDC",
    amountOut: "n/a",
    settlement: "LIMITATION",
    verification: "verified_evidence",
    note: "Revocation prevents new authorizations. Previously signed transactions may remain executable.",
    steps: [
      {
        label: "MPC sign A",
        href: `${CONFIG.nearblocks}/txns/CUdjGTYsr99sUh47inuiaxwAkwepdoZm9EfWLBNtqoLh`,
      },
      {
        label: "NEAR revoke",
        href: `${CONFIG.nearblocks}/txns/8xLvfZy8yMTwSDP4phfdP7DayKT59N1ehTjhgmGG1K7z`,
      },
      {
        label: "Sepolia broadcast A (status 0x1)",
        href: `${CONFIG.etherscan}/tx/0x90d4c64517f0e54082516a84ad0d9cf23a5671ea2e7f8877809615e894367199`,
      },
    ],
  },
];

export const PORTFOLIO_VERIFIED = {
  label: "Post Gate D snapshot (evidence)",
  verification: "verified_evidence" as const,
  asOf: "2026-11-09T12:20:00Z",
  chains: [
    {
      chain: "Ethereum Sepolia",
      tokens: [
        {
          symbol: "USDC",
          balance: "99",
          note: "100 faucet − 1 settled swap (Gate D)",
        },
        {
          symbol: "ETH",
          balance: "~0.05",
          note: "Gas funding drip",
        },
      ],
    },
    {
      chain: "Tidepool Intents (testnet)",
      tokens: [
        {
          symbol: "wNEAR",
          balance: "0.281057…",
          note: "Credited to MPC EVM identity after SUCCESS",
        },
      ],
    },
  ],
  mpcEvm: CONFIG.mpcEvm,
};
