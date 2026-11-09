import { CONFIG } from "../lib/config";

/**
 * Curated RECORDED VERIFIED EVIDENCE from Gates F4 / G / H.
 * Distinct from CURRENT LIVE READS via RPC / device session.
 */

export const EVIDENCE_AS_OF = "2026-11-09T14:46:00Z";

export const HARDWARE_OWNERSHIP = {
  verified: true,
  phase: "Hardware-only ownership verified",
  ledgerPublicKey: "ed25519:9omQYtUWotq8AbBhYbfbG7BUbDPjpKRCgeyLQAW48Xjh",
  derivationPath: "44'/397'/0'/0'/3'",
  nearAppVersion: "2.6.1",
  ownerAccount: CONFIG.ownerAccount,
  policyAccount: CONFIG.policyContract,
  setPolicyTx: "7SrK8M8eTFBGT6k6VxvaQBTwyMxa5TsdjXUiZkmMX2mb",
  revokeTx: "EndhGnPpena59sKXkxEoQqAELmT3mjUfHr9DZpSHqRq9",
  removeOwnerSoftwareTx: "cC32MZm8DUizXndrR7gfWoCRowDcTRwPCZ4UcPM3fi7",
  removePolicySoftwareTx: "EQZX8PBqJpwhVN3BA39CdkN6X3DqwDNADsZjdp1Xo3ok",
  revokeVerified: { revoked: true, mandate_epoch: 19 },
  note: "Ownership VERIFIED on-chain does not imply the Ledger is currently CONNECTED in this browser.",
};

/** Post–H1 revoke proof — do not auto-unrevoke. */
export const MANDATE_AFTER_H1 = {
  revoked: true,
  mandate_epoch: 19,
  note: "Hardware revoke proved ownership. Further agent/MPC demos need Ledger unrevoke.",
};

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

/** Deterministic strategy — NOT LLM trading intelligence. */
export const H3_DECISION = {
  choice: "TRADE" as const,
  strategy_id: "origin-usdc-to-wnear-v1",
  timestamp: "2026-11-09T13:46:05.757Z",
  amount_in: "1000000",
  amountInDisplay: "1 USDC",
  rationale:
    "Quote viable: minOut=279036267004249282582560, capacity ok, mandate active. Proceed via attestor→policy→MPC.",
  rejection_code: null as string | null,
  checks: [
    { ok: true, name: "mandate_active" },
    { ok: true, name: "risk_capacity", headroom: "100000000" },
    { ok: true, name: "quote_present" },
    { ok: true, name: "amount_match" },
    {
      ok: true,
      name: "min_out_floor",
      minOut: "279036267004249282582560",
      floor: "1",
    },
    { ok: true, name: "relative_rate", skipped: true },
    { ok: true, name: "quote_ttl" },
  ],
  quote_summary: {
    correlationId: "45adf4ce-1a01-4d37-bc0e-3cf6d20251d4",
    depositAddress: "0xE0078C1cf5De5A96afE976F0D8dCc4E8D20897a6",
    amountIn: "1000000",
    minAmountOut: "279036267004249282582560",
    deadline: "2026-11-09T14:31:05.423Z",
  },
  source: "live_gate_h" as const,
  ai_used: false,
  ai_note:
    "Deterministic strategy engine (packages/strategy/decide.mjs). AI not used as enforcement.",
};

export const H3_EXECUTION = {
  gate: "H3",
  status: "PASS" as const,
  operationId: "h3-1794231966936",
  proposeTx: "Ev1Uy7eQ4Zf8jG8WyC8cAKp9S3VhDiQrn94wngt9tkoD",
  mpcSignTx: "CGbXc3cHHv1jWGeaK4Xj2mAqE29NQ2UhmrgaUr9udKPC",
  sepoliaTx:
    "0xba28b97b8102dc160db6d89243c67e14538aef1cc0f415f7fbb2f9d903446d09",
  sepoliaStatus: "0x1",
  tidepoolStatus: "SUCCESS" as const,
  nearSettlementTxs: [
    "5mswTKnFdrsRwc5E372fuNrTeExxQ8gRfDPrE9CrmAgr",
    "3UnDQHnMzUD6WJno5quiMXVLdEUyCuYXQNZZgm2Uh3g7",
    "E7eYbBNoEXf97HVDLpncQfwW9SAKy2mxpb7S1Rx1BufA",
  ],
  reconcileTx: "CFj1Q12DVjEs6SCC2iATjju89hDK6Lzaz5TLBmauEeZ1",
  reconcileActor: "nio-c-recon-857107.testnet",
  trustModel: "trusted_attestor_not_tidepool_maker" as const,
  verification: "trusted_offchain_watchdog_not_onchain_proof" as const,
  attestationId: "9a14e20f2481d76819629b8352c4a35a03f3684dbe08d4f5197e9abb51dd57bf",
};

export const GATE_G_ACCOUNTING = {
  gate: "G",
  accountingStatus: "PASS" as const,
  ledgerStatus: "PASS" as const,
  overall: "PASS" as const,
  verification: "recorded_verified_evidence" as const,
  asOf: "2026-11-09T13:24:00Z",
  snapshot: {
    reserved_pending_exposure: "0",
    realized_exposure: "2000000",
    unresolved_pending: 0,
    economically_settled: true,
    mandate_epoch: 17,
    revoked: false,
    signing_revoked: false,
  },
  reconciler: "nio-c-recon-857107.testnet",
  reconcileNote:
    "H2: reconciler ≠ trading agent. evidence_hash stored; verified_onchain=false.",
  cleanupTx: "9MeJmCE5b1nzcdK6fMMft8vMx6Nx5GizYYWQZDDDzqUE",
  ledger: {
    ownershipVerified: true,
    label: "OWNERSHIP VERIFIED",
    softwareFullAccessRemaining: 0,
    note: HARDWARE_OWNERSHIP.note,
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
  label: "Post–Gate H3 recorded settlement",
  verification: "recorded_verified_evidence" as const,
  asOf: EVIDENCE_AS_OF,
  note: "Not a live wallet poll. H3 added another 1 USDC ORIGIN_CHAIN cycle after F4.",
  chains: [
    {
      chain: "Ethereum Sepolia",
      tokens: [
        {
          symbol: "USDC",
          balance: "F4 + H3 deposits executed",
          note: "See Evidence for 0xe49d5ff8… and 0xba28b97b…",
        },
      ],
    },
    {
      chain: "Tidepool Intents (testnet)",
      tokens: [
        {
          symbol: "wNEAR",
          balance: "credited after SUCCESS settles",
          note: "MPC EVM identity holds intents balance",
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

/** Agent readiness after full H1 revoke proof (current recorded end-state). */
export function agentStatusFromRecorded(): "revoked" | "ready" | "idle" {
  if (MANDATE_AFTER_H1.revoked) return "revoked";
  return "ready";
}
