/**
 * Smallest economically viable funded canary prep — readiness only, never executes.
 */
import { evaluateCanaryReadiness } from "./canary.mjs";
import { assertMainnetFundedAllowed, MAINNET_1CLICK } from "../execution/chainProfiles.mjs";
import { mainnetAuthGates } from "../networks/profiles.mjs";

export function prepareFundedCanaryApproval({
  proposal,
  matrix,
  journalWritable = false,
  policyDeployed = false,
  policyPaused = true,
  ledgerOwned = false,
  testnetLifecycleOk = false,
  ownerDestination,
  ownerRefund,
  verifiedBalances = {},
  env = process.env,
} = {}) {
  const gates = mainnetAuthGates(env);
  const blockers = [];

  if (!proposal || proposal.choice !== "TRADE") {
    blockers.push("no_eligible_trade_proposal");
  }
  if (
    proposal?.choice === "TRADE" &&
    proposal?.funded_execution !== "DISABLED"
  ) {
    blockers.push("proposal_must_remain_disabled_until_approval");
  }
  if (!ownerDestination) blockers.push("missing_owner_destination");
  if (!ownerRefund) blockers.push("missing_owner_refund");
  if (!journalWritable) blockers.push("tx_journal_not_writable_on_production_host");
  if (!policyDeployed) blockers.push("mainnet_policy_not_deployed");
  if (policyPaused) blockers.push("policy_still_paused_owner_unpause_required");
  if (!ledgerOwned) blockers.push("ledger_fullaccess_not_proven");
  if (!testnetLifecycleOk) blockers.push("testnet_lifecycle_not_proven");

  const asset = proposal?.source_token;
  const bal = asset ? verifiedBalances[asset] : null;
  if (!bal?.verified) blockers.push("source_balance_not_verified_on_chain");
  else if (BigInt(bal.amount_raw || "0") < BigInt(proposal.amount || "0")) {
    blockers.push("insufficient_verified_source_balance");
  }

  const fundedGate = assertMainnetFundedAllowed(MAINNET_1CLICK, {
    journal: journalWritable ? { assertWritable: () => true } : null,
    depositBound: { deposit_address: "pending_funded_quote", binding_ok: false },
    allowSign: false,
  });
  if (!fundedGate.ok) blockers.push(fundedGate.reason);

  const readiness = evaluateCanaryReadiness({
    approval: null,
    testnetLifecycleOk,
    policyDeployed,
    ledgerOwned,
    env,
  });
  blockers.push(...readiness.blockers);

  const approval_requirements = {
    owner_account: "Ledger-owned .near",
    chain: proposal?.source_chain || null,
    policy_contract: "policy.<owner>.near",
    source_token: proposal?.source_token || null,
    destination_token: proposal?.destination_token || null,
    max_at_risk: proposal?.amount || null,
    max_fees: "operator-set",
    destination_address: ownerDestination || null,
    refund_address: ownerRefund || null,
    purpose: "single smallest viable 1Click canary",
    quote_binding_digest: proposal?.binding_digest || null,
    env_flags_required_after_approval: [
      "NIO_NETWORK=mainnet",
      "NIO_MAINNET_MODE=1",
      "NIO_MAINNET_CANARY_APPROVED=1",
      "NIO_MAINNET_ALLOW_SIGN=1",
      "NIO_MAINNET_ALLOW_BROADCAST=1",
      "NIO_MAINNET_ALLOW_FUNDED_QUOTE=1",
      "NIO_MAINNET_FUNDED_UNLOCK=1",
    ],
    env_flags_now: gates,
  };

  return {
    ok: blockers.length === 0,
    verdict: blockers.length === 0 ? "GO" : "NO-GO",
    blockers: [...new Set(blockers)],
    proposal: proposal || { choice: "NO_TRADE" },
    matrix_summary: matrix?.matrix || null,
    approval_requirements,
    settlement_monitoring: {
      status_poll: "OneClickService.getExecutionStatus /v0/status",
      refund_recovery: "adapter.refundRecovery — never resign",
      journal: "SQLite WAL required before broadcast",
    },
    user_recovery: [
      "Owner pause/revoke on policy contract",
      "Await 1Click REFUND_PENDING → REFUNDED",
      "Owner-controlled refund address must match quote binding",
      "Ledger FullAccess recovers contract authority; does not reverse broadcast txs",
    ],
    funded_trade: "NO-GO",
    note: "Preparation artifact only — does not enable flags or broadcast",
  };
}
