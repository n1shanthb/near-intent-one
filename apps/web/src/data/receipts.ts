import { CONFIG } from "../lib/config";

/** Curated public hashes from EVIDENCE.md — not fabricated; for judge UI only. */
export type EvidenceReceipt = {
  id: string;
  gate: string;
  title: string;
  result: "PASS" | "PASS_LIMITATION" | "BLOCKED";
  summary: string;
  links: { label: string; href: string }[];
};

export const RECEIPTS: EvidenceReceipt[] = [
  {
    id: "gate-b-mpc",
    gate: "B",
    title: "Contract-controlled Chain Signature",
    result: "PASS",
    summary:
      "Policy contract requested MPC sign on path trading/v1/1; ECDSA verified against derived key.",
    links: [
      {
        label: "MPC sign tx",
        href: `${CONFIG.nearblocks}/txns/FUUXwoZHw9GcwVpCZYhH8oiB723NrrHr5Eq67HRxP5ss`,
      },
    ],
  },
  {
    id: "gate-b-revoke",
    gate: "B",
    title: "Revoke blocks new signing",
    result: "PASS",
    summary:
      "After owner revoke, agent propose_trade and request_signature fail on-chain.",
    links: [
      {
        label: "Revoke tx",
        href: `${CONFIG.nearblocks}/txns/GYhNaTYt5EGqgrnpvcnbB7go9c7qXfL22Tx8A8Lk5odt`,
      },
    ],
  },
  {
    id: "gate-c-verifier",
    gate: "C",
    title: "Verifier accepts MPC-signed EIP-191 intent",
    result: "PASS",
    summary:
      "execute_intents accepted signature (transfer event); failed later on balance — signature verdict PASS.",
    links: [
      {
        label: "execute_intents",
        href: `${CONFIG.nearblocks}/txns/DBaDiFaR1PdBzhgw546AW7VEqWBG8zkSVTVsaQTCfh6H`,
      },
    ],
  },
  {
    id: "gate-d-swap",
    gate: "D",
    title: "Funded ORIGIN_CHAIN swap SUCCESS",
    result: "PASS",
    summary:
      "1 USDC Sepolia → Tidepool SUCCESS; intents wNEAR credited to MPC EVM identity.",
    links: [
      {
        label: "Sepolia deposit",
        href: `${CONFIG.etherscan}/tx/0x67fde88c4251a2946b7d2ea172b2015a1d4b6dbfdd0b22d84a94a6d8efe75b6e`,
      },
    ],
  },
  {
    id: "gate-d-bad-deposit",
    gate: "D",
    title: "Deposit-address substitution rejected",
    result: "PASS",
    summary: "propose_trade to non-allowlisted 0x…0bad rejected on-chain.",
    links: [],
  },
  {
    id: "gate-e1",
    gate: "E1",
    title: "Unattended dynamic quote auth",
    result: "PASS_LIMITATION",
    summary:
      "Trusted attestor authorizes quote deposit without per-deposit allowlist. Tidepool maker pubkey verify BLOCKED.",
    links: [
      {
        label: "Propose quoted",
        href: `${CONFIG.nearblocks}/txns/CrGwFRGtn7cJ1V9HBkKAoTGq3XVMuAk31zgQ2U2sqBhv`,
      },
    ],
  },
  {
    id: "gate-e2",
    gate: "E2",
    title: "EIP-155 preimage binding",
    result: "PASS",
    summary:
      "Mismatch to/amount and legacy agent commitment rejected; digest computed on-chain.",
    links: [],
  },
  {
    id: "gate-e3",
    gate: "E3",
    title: "Revoke vs already-exported signature",
    result: "PASS_LIMITATION",
    summary:
      "Sign A → revoke → broadcast A still mined status 0x1. Propose B rejected while revoked. Revoke does not erase exported ECDSA.",
    links: [
      {
        label: "Broadcast A (after revoke)",
        href: `${CONFIG.etherscan}/tx/0x90d4c64517f0e54082516a84ad0d9cf23a5671ea2e7f8877809615e894367199`,
      },
      {
        label: "NEAR revoke",
        href: `${CONFIG.nearblocks}/txns/8xLvfZy8yMTwSDP4phfdP7DayKT59N1ehTjhgmGG1K7z`,
      },
    ],
  },
  {
    id: "gate-f4",
    gate: "F4",
    title: "Unattended ORIGIN_CHAIN settle",
    result: "PASS",
    summary:
      "Frozen policy epoch 17 · attestor → MPC → Sepolia 0xe49d5ff8… → Tidepool SUCCESS → reconcile. Trust: trusted_attestor_not_tidepool_maker.",
    links: [
      {
        label: "Sepolia F4",
        href: `${CONFIG.etherscan}/tx/0xe49d5ff80fd8533d9719969b50647e49c99845d79fac27d39578e4003552e558`,
      },
      {
        label: "NEAR settlement",
        href: `${CONFIG.nearblocks}/txns/B6uEASppdZmHM25RxiF5U9rs3K98eEkPj77Z8JhGcKfY`,
      },
    ],
  },
  {
    id: "gate-g-accounting",
    gate: "G",
    title: "Accounting settle",
    result: "PASS",
    summary:
      "reserved=0 · unresolved=0 · economically_settled=true. Ledger closed in H1.",
    links: [
      {
        label: "Cleanup reconcile",
        href: `${CONFIG.nearblocks}/txns/9MeJmCE5b1nzcdK6fMMft8vMx6Nx5GizYYWQZDDDzqUE`,
      },
    ],
  },
  {
    id: "gate-h1",
    gate: "H1",
    title: "Ledger-only ownership",
    result: "PASS",
    summary:
      "Hardware set_policy + revoke + software key removal. Owner+policy FullAccess = Ledger only.",
    links: [
      {
        label: "set_policy",
        href: `${CONFIG.nearblocks}/txns/7SrK8M8eTFBGT6k6VxvaQBTwyMxa5TsdjXUiZkmMX2mb`,
      },
      {
        label: "revoke",
        href: `${CONFIG.nearblocks}/txns/EndhGnPpena59sKXkxEoQqAELmT3mjUfHr9DZpSHqRq9`,
      },
    ],
  },
  {
    id: "gate-h3",
    gate: "H3",
    title: "Deterministic strategy TRADE",
    result: "PASS",
    summary:
      "decide.mjs TRADE → MPC CGbXc3cH… → Sepolia 0xba28b97b… → Tidepool SUCCESS → reconcile CFj1Q12D…",
    links: [
      {
        label: "Sepolia H3",
        href: `${CONFIG.etherscan}/tx/0xba28b97b8102dc160db6d89243c67e14538aef1cc0f415f7fbb2f9d903446d09`,
      },
      {
        label: "NEAR MPC",
        href: `${CONFIG.nearblocks}/txns/CGbXc3cHHv1jWGeaK4Xj2mAqE29NQ2UhmrgaUr9udKPC`,
      },
    ],
  },
];

export const SECURITY_DEMOS = [
  {
    id: "bad-deposit",
    title: "Bad deposit address",
    expect: "BLOCK",
    how: "Agent proposes trade to an address not bound by policy/attestation.",
    evidence: "gate-d-bad-deposit",
  },
  {
    id: "expired-attestation",
    title: "Expired quote attestation",
    expect: "BLOCK",
    how: "propose_quoted_evm_transfer with past quote_deadline_ns.",
    evidence: "gate-e1",
  },
  {
    id: "untrusted-signer",
    title: "Untrusted attestor key",
    expect: "BLOCK",
    how: "Attestation signed by a key not pinned via set_trusted_quote_signer.",
    evidence: "gate-e1",
  },
  {
    id: "preimage-mismatch",
    title: "tx.to / amount ≠ attestation",
    expect: "BLOCK",
    how: "Agent supplies EvmTxParams inconsistent with attested deposit/amount.",
    evidence: "gate-e2",
  },
  {
    id: "post-revoke-propose",
    title: "Propose after revoke",
    expect: "BLOCK",
    how: "New propose while revoked=true is rejected (new MPC signing stopped).",
    evidence: "gate-e3",
  },
  {
    id: "exported-sig-survives",
    title: "Pre-revoke signature still executable",
    expect: "LIMITATION",
    how: "Already-exported EVM tx A broadcasts successfully after NEAR revoke.",
    evidence: "gate-e3",
  },
];

export const JUDGE_STEPS = [
  {
    n: 1,
    do: "Open this app and click Fetch dry quote",
    see: "A live Tidepool quote preview (amountOut / deadline) with dry:true — no funds moved",
  },
  {
    n: 2,
    do: "Click Refresh mandate",
    see: "Live policy views: owner, agent, epoch, revoked flag, derivation path, exposure",
  },
  {
    n: 3,
    do: "Open Security demos",
    see: "Mapped BLOCK cases from Gates D/E plus the E3 exported-signature limitation",
  },
  {
    n: 4,
    do: "Open Evidence receipts",
    see: "Explorer links for Gates B–E (PASS / PASS_LIMITATION) — hashes from EVIDENCE.md",
  },
  {
    n: 5,
    do: "Read What the agent cannot do",
    see: "Agent cannot revoke, set_policy, choose alternate EIP-155 digest, or fabricate settlement",
  },
];
