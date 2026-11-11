/**
 * Honest real-user onboarding journey — every step is data-driven.
 * Statuses: READY | BLOCKED | PENDING | UNSUPPORTED
 */
import type { MainnetEvidenceRecord } from "../data/mainnetEvidence";
import { MAINNET_EVIDENCE } from "../data/mainnetEvidence";
import {
  evaluateDepositReadiness,
  publicMainnetDepositsAllowed,
} from "./depositReadiness";
import { mainnetTradingControlsEnabled } from "./network";
import { isDemoPortfolioId } from "./publicDemo";

export type JourneyStepStatus =
  | "READY"
  | "BLOCKED"
  | "PENDING"
  | "UNSUPPORTED";

export type JourneyStepId =
  | "connect_wallet"
  | "verify_ownership"
  | "create_portfolio"
  | "authorize_mandate"
  | "verify_contract"
  | "deposit"
  | "enable_agent"
  | "trade"
  | "withdraw";

export type JourneyStep = {
  id: JourneyStepId;
  title: string;
  status: JourneyStepStatus;
  detail: string;
  operatorRequired?: boolean;
};

export type JourneyInput = {
  walletConnected: boolean;
  ownerVerified: boolean;
  ownerAccountId?: string | null;
  /** Personal portfolio lookup status from owner gateway. */
  portfolioStatus?: string | null;
  portfolioId?: string | null;
  portfolioOwner?: string | null;
  policyContract?: string | null;
  intentsSignerId?: string | null;
  mandateOnChain?: boolean | null;
  mandateEpoch?: number | null;
  withdrawDeliveryProven?: boolean;
  evidence?: MainnetEvidenceRecord;
  /** Active workspace network from health. */
  network?: string | null;
};

const ORDER: JourneyStepId[] = [
  "connect_wallet",
  "verify_ownership",
  "create_portfolio",
  "authorize_mandate",
  "verify_contract",
  "deposit",
  "enable_agent",
  "trade",
  "withdraw",
];

const TITLES: Record<JourneyStepId, string> = {
  connect_wallet: "Connect wallet",
  verify_ownership: "Verify ownership",
  create_portfolio: "Create / associate portfolio",
  authorize_mandate: "Authorize mandate",
  verify_contract: "Verify contract",
  deposit: "Deposit",
  enable_agent: "Enable agent",
  trade: "Trade",
  withdraw: "Withdraw",
};

export function buildOnboardingJourney(input: JourneyInput): JourneyStep[] {
  const ev = input.evidence ?? MAINNET_EVIDENCE;
  const isMainnet = (input.network ?? "").toLowerCase() === "mainnet";
  const personalReady =
    input.portfolioStatus === "ready" &&
    Boolean(input.portfolioId) &&
    !isDemoPortfolioId(input.portfolioId ?? "") &&
    Boolean(input.policyContract);

  const awaitingProvision =
    input.portfolioStatus === "awaiting_operator" ||
    input.portfolioStatus === "queued_self" ||
    input.portfolioStatus === "blocked";

  const deposit = evaluateDepositReadiness({
    chain: isMainnet ? "mainnet" : "sepolia",
    ownerVerified: input.ownerVerified,
    ownerAccountId: input.ownerAccountId,
    portfolioId: input.portfolioId,
    portfolioOwner: input.portfolioOwner,
    policyContract: input.policyContract,
    intentsSignerId: input.intentsSignerId,
    backendReady: personalReady,
    portfolioStatus: input.portfolioStatus,
    evidence: ev,
  });

  const trading = mainnetTradingControlsEnabled(ev) && publicMainnetDepositsAllowed();

  const steps: Record<JourneyStepId, JourneyStep> = {
    connect_wallet: {
      id: "connect_wallet",
      title: TITLES.connect_wallet,
      status: input.walletConnected || input.ownerVerified ? "READY" : "PENDING",
      detail: input.ownerVerified
        ? "Ledger path connected for ownership proof"
        : input.walletConnected
          ? "NEAR wallet connected — ownership not yet verified"
          : "Connect Ledger (owner path) or NEAR wallet (separate product path)",
    },
    verify_ownership: {
      id: "verify_ownership",
      title: TITLES.verify_ownership,
      status: input.ownerVerified ? "READY" : "BLOCKED",
      detail: input.ownerVerified
        ? `Verified owner session for ${input.ownerAccountId ?? "account"}`
        : "NEP-413 owner verification required. Login alone does not authorize trading.",
    },
    create_portfolio: {
      id: "create_portfolio",
      title: TITLES.create_portfolio,
      status: !input.ownerVerified
        ? "BLOCKED"
        : personalReady
          ? "READY"
          : awaitingProvision
            ? "PENDING"
            : "BLOCKED",
      detail: !input.ownerVerified
        ? "Verify ownership first"
        : personalReady
          ? `Portfolio ${input.portfolioId}`
          : awaitingProvision
            ? "Operator provisioning required — self-provision is OFF on this host"
            : "No personal portfolio associated yet",
      operatorRequired: awaitingProvision || (!personalReady && input.ownerVerified),
    },
    authorize_mandate: {
      id: "authorize_mandate",
      title: TITLES.authorize_mandate,
      status: !personalReady
        ? "BLOCKED"
        : input.mandateOnChain
          ? "READY"
          : "PENDING",
      detail: !personalReady
        ? "Needs provisioned portfolio + policy account"
        : input.mandateOnChain
          ? `On-chain mandate epoch ${input.mandateEpoch ?? "—"}`
          : "Compose + Ledger set_policy required — not decorative connect",
    },
    verify_contract: {
      id: "verify_contract",
      title: TITLES.verify_contract,
      status: ev.capabilities.contract_deployed && ev.contract.account_id
        ? "READY"
        : isMainnet
          ? "BLOCKED"
          : personalReady && input.policyContract
            ? "PENDING"
            : "BLOCKED",
      detail: ev.contract.account_id
        ? `Verified ${ev.contract.account_id}`
        : isMainnet
          ? "Mainnet contract not independently verified"
          : input.policyContract
            ? `Testnet policy ${input.policyContract} — confirm on explorer`
            : "No policy contract bound",
    },
    deposit: {
      id: "deposit",
      title: TITLES.deposit,
      status: deposit.allowed ? "READY" : "BLOCKED",
      detail: deposit.message,
    },
    enable_agent: {
      id: "enable_agent",
      title: TITLES.enable_agent,
      status: !input.ownerVerified
        ? "BLOCKED"
        : !personalReady
          ? "BLOCKED"
          : "PENDING",
      detail: !input.ownerVerified
        ? "Verified owner session required before start/stop controls"
        : !personalReady
          ? "Personal portfolio not ready"
          : "Agent start stays owner-gated; autonomous funded mode remains OFF",
    },
    trade: {
      id: "trade",
      title: TITLES.trade,
      status: trading
        ? "READY"
        : isMainnet
          ? "BLOCKED"
          : "UNSUPPORTED",
      detail: trading
        ? "Mainnet trading gates green (unexpected in this sprint)"
        : isMainnet
          ? "Mainnet funded trading disabled — dry quotes are not deposit instructions"
          : "Public Live AI is dry-run only (may_sign=false). Four-chain adapters unsupported for funded execution.",
    },
    withdraw: {
      id: "withdraw",
      title: TITLES.withdraw,
      status: !input.ownerVerified
        ? "BLOCKED"
        : input.withdrawDeliveryProven
          ? "PENDING"
          : "BLOCKED",
      detail: !input.ownerVerified
        ? "Owner session required"
        : input.withdrawDeliveryProven
          ? "Delivery path proven historically — each withdraw still needs owner signature; independent recovery not fully productized"
          : "Withdraw delivery not unlocked for this deployment",
    },
  };

  return ORDER.map((id) => steps[id]);
}

export function journeyTone(
  status: JourneyStepStatus
): "success" | "warn" | "idle" | "danger" {
  switch (status) {
    case "READY":
      return "success";
    case "PENDING":
      return "warn";
    case "UNSUPPORTED":
      return "idle";
    case "BLOCKED":
    default:
      return "danger";
  }
}
