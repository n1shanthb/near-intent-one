import { CONFIG } from "../lib/config";

/**
 * Curated RECORDED VERIFIED EVIDENCE from Gates F4 / G.
 * Hashes match EVIDENCE.md / evidence/live — not fabricated.
 * Distinct from CURRENT LIVE READS via RPC.
 */

export const EVIDENCE_AS_OF = "2026-11-09T13:24:00Z";

export const F4_EXECUTION = {
  gate: "F4",
  status: "PASS" as const,
  verification: "recorded_verified_evidence" as const,
  title: "Unattended Sepolia USDC → Tidepool wNEAR",
  when: "2026-11-09T13:03:00Z–13:04:25Z",
  operationId: "f4-1794229389740",
  correlationId: "60382844-a409-4976-896e-2b994d84420c",
  amountIn: "1000000",
  amountInDisplay: "1 USDC",
  minAmountOut: "276693696619382038772160",
  depositAddress: "0x13d3eCFF74D5c4EEddcFEb6d4503e9574063D61A",
  trustModel: "trusted_attestor_not_tidepool_maker" as const,
  attestationId: "7a6b8d421b839673e38a372d6b5a621623b8e760bc3846af35b9ad4318e853f5",
  attestorPublicKey: "ed25519:14HKGFGeR7eEuQhSr63dKSYtsCQLxED97wFqNEyh63Hz",
  policyEpoch: 17,
  policyUnchanged: true,
  noDepositAllowlist: true,
  tidepoolStatus: "SUCCESS" as const,
  intentsWnearAfter: "560545791483368286640000",
  intentsWnearDisplay: "≈0.5605 wNEAR (intents balance after F4)",
  steps: [
    {
      id: "policy",
      label: "Owner policy (frozen)",
      detail: "Epoch 17 · no mid-cycle set_policy / deposit allowlist",
      href: undefined as string | undefined,
    },
    {
      id: "agent",
      label: "Agent proposal",
      detail: "propose_quoted_evm_transfer · f4-1794229389740",
      href: `${CONFIG.nearblocks}/txns/Hsmo6jpiPjHPymp5BT8c2xA7qcHchf7V3pS7jf1Kw9YZ`,
    },
    {
      id: "attestor",
      label: "Quote attestor (V2)",
      detail: "Trusted attestor — not Tidepool maker verify",
      href: undefined,
    },
    {
      id: "mpc",
      label: "NEAR Chain Signature (MPC)",
      detail: "Contract-controlled request_signature",
      href: `${CONFIG.nearblocks}/txns/57PFgc6bxUyfhEidrHdGuMrZ1YxHuX19H5yMCU3ubqA8`,
    },
    {
      id: "sepolia",
      label: "Sepolia execution",
      detail: "ERC-20 deposit · receipt 0x1",
      href: `${CONFIG.etherscan}/tx/0xe49d5ff80fd8533d9719969b50647e49c99845d79fac27d39578e4003552e558`,
    },
    {
      id: "intents",
      label: "NEAR Intents settlement",
      detail: "Tidepool SUCCESS",
      href: `${CONFIG.nearblocks}/txns/B6uEASppdZmHM25RxiF5U9rs3K98eEkPj77Z8JhGcKfY`,
    },
    {
      id: "reconcile",
      label: "Reconcile Success",
      detail: "reconcile_pending · evidence pointer (not on-chain verified)",
      href: `${CONFIG.nearblocks}/txns/4CUdfdUq8Dh8AFYCVQGFMrrN4Nwqudz1Ccy1e9BCLXGw`,
    },
  ],
  nearSettlementTxs: [
    "B6uEASppdZmHM25RxiF5U9rs3K98eEkPj77Z8JhGcKfY",
    "AFXqmLLPsAzCWv5aM2vDxmbm27Hze8En4yq4inne9du8",
    "A89wvpNrMd9d9XQTH6uCz2AZboDcL1mtMMkDL6KfUgBw",
  ],
  sepoliaTx:
    "0xe49d5ff80fd8533d9719969b50647e49c99845d79fac27d39578e4003552e558",
  reconcileTx: "4CUdfdUq8Dh8AFYCVQGFMrrN4Nwqudz1Ccy1e9BCLXGw",
  proposeTx: "Hsmo6jpiPjHPymp5BT8c2xA7qcHchf7V3pS7jf1Kw9YZ",
  mpcSignTx: "57PFgc6bxUyfhEidrHdGuMrZ1YxHuX19H5yMCU3ubqA8",
};

export const GATE_G_ACCOUNTING = {
  gate: "G",
  accountingStatus: "PASS" as const,
  ledgerStatus: "BLOCKED" as const,
  overall: "BLOCKED" as const,
  verification: "recorded_verified_evidence" as const,
  asOf: EVIDENCE_AS_OF,
  snapshot: {
    reserved_pending_exposure: "0",
    realized_exposure: "2000000",
    unresolved_pending: 0,
    economically_settled: true,
    mandate_epoch: 17,
    revoked: false,
    signing_revoked: false,
  },
  reconciler: "nio-c-agent-857107.testnet",
  reconcileNote:
    "evidence_hash stored on-chain; verified_onchain=false — owner/reconciler must check receipts off-chain",
  cleanupTx: "9MeJmCE5b1nzcdK6fMMft8vMx6Nx5GizYYWQZDDDzqUE",
  ledger: {
    connected: false,
    proven: false,
    label: "NOT CONNECTED / NOT PROVEN",
    softwareFullAccessRemaining: 1,
    note: "Physical Ledger set_policy/revoke not demonstrated. Gate H owns hardware path.",
  },
};

export const FROZEN_POLICY = {
  max_trade_value: "100000000",
  daily_turnover_limit: "1000000000",
  max_pending_exposure: "100000000",
  max_slippage_bps: 100,
  allowed_assets: [
    "nep141:eth-0x2e6ad9e6d59bb4585ea0e6762c3b637dde29dad2.tp-omft.testnet",
    "nep141:wnear.tidepool-sandbox.testnet",
    "USDC",
    "NEAR",
  ],
  allowed_destinations: ["bob.testnet", "nio-c-owner-857107.testnet"],
  valid_until: "1893456000000000000",
  epoch: 17,
};

export const PORTFOLIO_RECORDED = {
  label: "Post–Gate F4 / G recorded snapshot",
  verification: "recorded_verified_evidence" as const,
  asOf: EVIDENCE_AS_OF,
  note: "Not a live wallet poll. Switch to Live mode for current RPC reads.",
  chains: [
    {
      chain: "Ethereum Sepolia",
      tokens: [
        {
          symbol: "USDC",
          balance: "expended 1 USDC in F4",
          note: "Deposit tx 0xe49d5ff8… (see Activity)",
        },
      ],
    },
    {
      chain: "Tidepool Intents (testnet)",
      tokens: [
        {
          symbol: "wNEAR",
          balance: "≈0.5605",
          note: "Intents balance after F4 SUCCESS (560545791483368286640000 raw)",
        },
      ],
    },
  ],
  mpcEvm: CONFIG.mpcEvm,
};

export const ADVERSARIAL_DEMOS = [
  {
    id: "f1-bad-deposit",
    title: "Attestor refuses substituted deposit",
    result: "BLOCK",
    detail:
      "Agent requestedDeposit ≠ quote.depositAddress → attestor refuses to sign",
  },
  {
    id: "f1-replay",
    title: "Replay attestation rejected on-chain",
    result: "BLOCK",
    detail: "Duplicate QUOTE_AUTH_V2 attestation → contract reject",
  },
  {
    id: "e2-preimage",
    title: "EIP-155 to/amount mismatch",
    result: "BLOCK",
    detail: "On-chain digest binding rejects adversarial tx fields",
  },
  {
    id: "e3-post-revoke",
    title: "Propose after revoke",
    result: "BLOCK",
    detail: "New signing blocked; exported sig A still executable (limitation)",
  },
];

export function agentStatusFromRecorded(): "ready" | "idle" {
  const s = GATE_G_ACCOUNTING.snapshot;
  if (
    !s.revoked &&
    s.economically_settled &&
    s.unresolved_pending === 0 &&
    s.reserved_pending_exposure === "0"
  ) {
    return "ready";
  }
  return "idle";
}
