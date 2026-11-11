/**
 * One-user tiny-value mainnet canary — never auto-activates.
 * Contract-deploy gas approval is separate from trading approval.
 */
import {
  assertMainnetCanaryAuthorized,
  mainnetAuthGates,
  MAINNET,
} from "../networks/profiles.mjs";

export const CANARY_APPROVAL_SCHEMA = Object.freeze([
  "owner_account",
  "chain",
  "policy_contract",
  "source_token",
  "destination_token",
  "max_at_risk",
  "max_fees",
  "destination_address",
  "refund_address",
  "purpose",
]);

export function evaluateCanaryReadiness({
  approval = null,
  testnetLifecycleOk = false,
  policyDeployed = false,
  ledgerOwned = false,
  env = process.env,
} = {}) {
  const gates = mainnetAuthGates(env);
  const blockers = [];

  if (!gates.public_demo_safe) {
    blockers.push("public_demo_host_not_testnet");
  }
  if (!testnetLifecycleOk) {
    blockers.push(
      "testnet_lifecycle_not_proven_recoverable — failed/unsettled testnet blocks funded mainnet canary"
    );
  }
  if (!policyDeployed) {
    blockers.push("mainnet_policy_contract_not_deployed");
  }
  if (!ledgerOwned) {
    blockers.push(
      "ledger_owned_mandate_not_proven — deployed contract ≠ Ledger-owned production mandate"
    );
  }

  const auth = approval
    ? assertMainnetCanaryAuthorized(approval, env)
    : { ok: false, reason: "approval_object_missing" };

  if (!auth.ok) blockers.push(auth.reason);

  if (gates.allow_broadcast && !gates.allow_sign) {
    blockers.push("broadcast_without_sign_forbidden");
  }

  return {
    ready: blockers.length === 0 && auth.ok === true && gates.allow_sign,
    gates,
    auth,
    blockers,
    signing_default: "OFF",
    broadcast_default: "OFF",
    network_profile: MAINNET.id,
    note: "Do not activate canary until operator signs the exact approval fields",
  };
}

/** Pure policy checks for mainnet trade path — no acceptance override. */
export function mainnetTradeSafetyCheck({
  sessionAccount,
  portfolioOwner,
  mandate,
  fitter,
  critic,
  quote,
  maxSlippageBps,
  destination,
  refund,
  isDemo = false,
} = {}) {
  const fails = [];
  if (isDemo) fails.push("demo_portfolio_banned");
  if (!sessionAccount || sessionAccount !== portfolioOwner) {
    fails.push("owner_session_mismatch");
  }
  if (!String(sessionAccount || "").endsWith(".near")) {
    fails.push("session_not_mainnet_account");
  }
  if (!mandate || mandate.revoked || mandate.paused) {
    fails.push("mandate_inactive");
  }
  if (mandate?.signing_revoked) fails.push("signing_revoked");
  if (!fitter || fitter.decision !== "APPROVE") {
    fails.push("fitter_not_approve");
  }
  if (!critic || critic.decision !== "APPROVE") {
    fails.push("critic_not_approve");
  }
  // Explicit: never flip AI reject → approve
  if (fitter?.decision === "REJECT" || critic?.decision === "REJECT") {
    fails.push("ai_rejection_is_final_no_override");
  }
  if (!quote?.fresh) fails.push("stale_or_missing_quote");
  if (
    quote?.slippage_bps != null &&
    maxSlippageBps != null &&
    Number(quote.slippage_bps) > Number(maxSlippageBps)
  ) {
    fails.push("slippage_exceeded");
  }
  if (!destination || destination !== quote?.recipient) {
    fails.push("destination_mismatch");
  }
  if (!refund || refund !== quote?.refundTo) {
    fails.push("refund_mismatch");
  }

  if (fails.length) {
    return {
      ok: false,
      status: "BLOCKED",
      reasons: fails,
      acceptance_override: "FORBIDDEN",
    };
  }
  return {
    ok: true,
    status: "SAFETY_PASS_PRE_SIGN",
    acceptance_override: "FORBIDDEN",
    note: "Still requires NIO_MAINNET_ALLOW_SIGN=1 and canary approval before sign",
  };
}
