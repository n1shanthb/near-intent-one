/**
 * Deposit readiness — never surface a fundable mainnet address until every gate passes.
 * Sprint rule: public funded trading and mainnet deposits stay OFF.
 */
import {
  MAINNET_EVIDENCE,
  type MainnetEvidenceRecord,
} from "../data/mainnetEvidence";
import { isDemoPortfolioId } from "./publicDemo";

export type DepositChainKind = "mainnet_like" | "testnet_like" | "unknown";

export type DepositReadinessInput = {
  chain: string;
  /** Verified owner cookie session. */
  ownerVerified: boolean;
  ownerAccountId?: string | null;
  portfolioId?: string | null;
  portfolioOwner?: string | null;
  policyContract?: string | null;
  intentsSignerId?: string | null;
  /** Backend / portfolio status from lookup or health. */
  backendReady?: boolean;
  portfolioStatus?: string | null;
  /** Explicit env unlock — must never be set for public mainnet this sprint. */
  depositCapabilityEnv?: boolean;
  evidence?: MainnetEvidenceRecord;
};

export type DepositGateCheck = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
};

export type DepositReadiness = {
  allowed: boolean;
  chainKind: DepositChainKind;
  /** User-facing block copy when not allowed. */
  message: string;
  reason: string;
  checks: DepositGateCheck[];
};

const MAINNET_BLOCK =
  "Mainnet deposits are not enabled. Do not send funds.";

const MAINNET_CHAINS = new Set([
  "mainnet",
  "near-mainnet",
  "ethereum",
  "eth",
  "ethereum-mainnet",
  "arbitrum",
  "arb",
  "arbitrum-one",
  "base",
  "base-mainnet",
]);

const TESTNET_CHAINS = new Set([
  "testnet",
  "near-testnet",
  "near",
  "sepolia",
  "ethereum-sepolia",
  "arb-sepolia",
  "base-sepolia",
]);

export function classifyDepositChain(chain: string): DepositChainKind {
  const c = chain.trim().toLowerCase();
  if (MAINNET_CHAINS.has(c)) return "mainnet_like";
  if (TESTNET_CHAINS.has(c)) return "testnet_like";
  if (c.includes("mainnet") || c === "eth" || c === "arb") return "mainnet_like";
  if (c.includes("testnet") || c.includes("sepolia")) return "testnet_like";
  return "unknown";
}

/** Hard product lock for this sprint — ignore accidental env flips on public builds. */
export function publicMainnetDepositsAllowed(): boolean {
  return false;
}

export function evaluateDepositReadiness(
  input: DepositReadinessInput
): DepositReadiness {
  const ev = input.evidence ?? MAINNET_EVIDENCE;
  const chainKind = classifyDepositChain(input.chain);
  const envUnlock =
    input.depositCapabilityEnv ??
    import.meta.env.VITE_NIO_DEPOSITS_ENABLED === "true";

  const checks: DepositGateCheck[] = [
    {
      id: "contract_deployed",
      label: "Contract deployed on correct mainnet account",
      ok: Boolean(
        ev.capabilities.contract_deployed && ev.contract.account_id
      ),
      detail: ev.contract.account_id
        ? `Account ${ev.contract.account_id}`
        : "No verified mainnet contract account",
    },
    {
      id: "owner_matched",
      label: "Owner matched",
      ok: Boolean(
        input.ownerVerified &&
          input.ownerAccountId &&
          input.portfolioOwner &&
          input.ownerAccountId === input.portfolioOwner &&
          (!ev.policy.owner_account ||
            ev.policy.owner_account === input.ownerAccountId)
      ),
      detail:
        input.ownerVerified && input.ownerAccountId
          ? `Session ${input.ownerAccountId}`
          : "Verified owner session required",
    },
    {
      id: "policy_initialized",
      label: "Mainnet policy initialized",
      ok: Boolean(ev.capabilities.policy_active && ev.policy.active),
      detail: ev.policy.active
        ? `Epoch ${ev.policy.epoch ?? "?"}`
        : "Policy not active on mainnet evidence pack",
    },
    {
      id: "mpc_derived",
      label: "Correct MPC address derived",
      ok: Boolean(
        ev.capabilities.mpc_ready &&
          ev.mpc.ready &&
          ev.mpc.derived_evm_address
      ),
      detail: ev.mpc.derived_evm_address
        ? ev.mpc.derived_evm_address
        : ev.mpc.integration_status,
    },
    {
      id: "custody_recovery",
      label: "Custody / recovery instructions available",
      ok: Boolean(ev.capabilities.custody_recovery_documented),
      detail: ev.capabilities.custody_recovery_documented
        ? "Documented"
        : "Recovery path not demonstrated for public mainnet deposits",
    },
    {
      id: "deposit_capability",
      label: "Deposit capability explicitly enabled",
      ok: Boolean(
        ev.capabilities.deposit_capability_enabled &&
          envUnlock &&
          publicMainnetDepositsAllowed()
      ),
      detail: "Public sprint lock — mainnet deposits remain disabled",
    },
    {
      id: "backend_ready",
      label: "Backend reports readiness for portfolio + chain",
      ok: Boolean(
        input.backendReady &&
          input.portfolioStatus === "ready" &&
          input.portfolioId &&
          !isDemoPortfolioId(input.portfolioId) &&
          Boolean(input.policyContract) &&
          Boolean(input.intentsSignerId)
      ),
      detail: input.backendReady
        ? `status=${input.portfolioStatus ?? "unknown"}`
        : "Backend readiness not confirmed",
    },
  ];

  if (chainKind === "mainnet_like" || chainKind === "unknown") {
    const allOk = checks.every((c) => c.ok);
    // Sprint hard lock — even if evidence were filled, publicMainnetDepositsAllowed is false.
    if (!allOk || !publicMainnetDepositsAllowed()) {
      return {
        allowed: false,
        chainKind,
        message: MAINNET_BLOCK,
        reason: "mainnet_deposits_disabled",
        checks,
      };
    }
  }

  // Testnet-like: still require owner session + non-demo personal portfolio.
  // Never treat derived MPC / dry quote as an automatic deposit instruction.
  const testnetOwnerOk =
    input.ownerVerified &&
    Boolean(input.ownerAccountId) &&
    Boolean(input.portfolioId) &&
    !isDemoPortfolioId(input.portfolioId ?? "") &&
    Boolean(input.portfolioOwner) &&
    input.ownerAccountId === input.portfolioOwner;

  if (chainKind === "testnet_like") {
    if (!testnetOwnerOk) {
      return {
        allowed: false,
        chainKind,
        message:
          "Deposit addresses require a verified owner session for your personal portfolio. Do not send funds to demo or derived addresses shown elsewhere.",
        reason: "owner_session_required",
        checks,
      };
    }
    // Public product still refuses to mint deposit instructions until Chat 1
    // exposes an explicit deposit-ready flag on health / portfolio.
    if (import.meta.env.VITE_NIO_TESTNET_DEPOSITS_ENABLED !== "true") {
      return {
        allowed: false,
        chainKind,
        message:
          "Personal deposit address issuance stays blocked until deposit capability is explicitly enabled for this deployment. Do not send funds.",
        reason: "testnet_deposits_not_enabled",
        checks,
      };
    }
    return {
      allowed: true,
      chainKind,
      message: "Deposit issuance allowed for verified personal testnet portfolio.",
      reason: "ok",
      checks,
    };
  }

  return {
    allowed: false,
    chainKind,
    message: MAINNET_BLOCK,
    reason: "mainnet_deposits_disabled",
    checks,
  };
}

/** Never present a dry quote / derived address as a fundable deposit instruction. */
export function isFundableDepositInstructionAllowed(
  readiness: DepositReadiness
): boolean {
  return readiness.allowed;
}
