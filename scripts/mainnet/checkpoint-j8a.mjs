#!/usr/bin/env node
/**
 * Checkpoint J8A — preflight first real mainnet 1-USDC trade.
 * Read-only + local simulation. NO unpause, propose, MPC sign, or broadcast.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runJ8aPreflight,
  buildJ8bRunbook,
} from "../../packages/mainnet/j8a.preflight.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, "docs/evidence");
mkdirSync(OUT, { recursive: true });

function sanitize(preflight) {
  // Drop any accidental secret material; keep public evidence only.
  const a = preflight.attestation || {};
  return {
    ...preflight,
    attestation: {
      ...a,
      // never include full signature bytes beyond prefix already set
      signature: undefined,
      message_utf8: undefined,
    },
  };
}

function renderMd(e, runbook) {
  const b = e.funding.balances;
  const lines = [
    "# Checkpoint J8A - First real mainnet trade preflight",
    "",
    "**NO unpause / NO propose / NO request_signature / NO broadcast / NO escrow deposit**",
    "",
    "## GO / NO-GO",
    "",
    "- Preflight: **" + e.go_no_go.preflight + "**",
    "- Execution: **" + e.go_no_go.execution + "**",
    "- " + e.go_no_go.reason,
    "",
    "## Live funding balances",
    "",
    "| Chain | ETH | Native USDC | Nonce |",
    "|-------|-----|-------------|-------|",
    "| Arbitrum 42161 | " +
      b.arbitrum.eth +
      " (" +
      b.arbitrum.eth_wei +
      " wei) | " +
      b.arbitrum.usdc +
      " raw=" +
      b.arbitrum.usdc_raw +
      " | " +
      b.arbitrum.nonce +
      " |",
    "| Base | " +
      b.base.eth +
      " | " +
      b.base.usdc +
      " raw=" +
      b.base.usdc_raw +
      " | — |",
    "",
    "Funding receipts: ETH `" +
      e.funding.eth_tx +
      "` ok=" +
      e.funding.eth_receipt_ok +
      " · USDC `" +
      e.funding.usdc_tx +
      "` ok=" +
      e.funding.usdc_receipt_ok,
    "",
    "## Policy",
    "",
    "- paused=" +
      e.policy.paused +
      " autonomous=" +
      e.policy.autonomous_trading +
      " epoch=" +
      e.policy.mandate_epoch +
      " trusted=" +
      e.policy.trusted_attestor,
    "- intents_signer_id=" + e.policy.intents_signer_id,
    "- reserved_pending_exposure=" +
      JSON.stringify(e.policy.reserved_pending_exposure),
    "- arb/base USDC allowed=" +
      e.policy.limits.arb_usdc_allowed +
      "/" +
      e.policy.limits.base_usdc_allowed +
      " mpc_dest=" +
      e.policy.limits.mpc_destination_allowed,
    "",
    "## Fresh quote",
    "",
    "- result: **" +
      (e.quote.ok ? "PASS" : "BLOCKED") +
      "** dry=" +
      e.quote.dry,
    "- amount_in=" +
      e.quote.amount_in +
      " amount_out=" +
      e.quote.amount_out +
      " min_out=" +
      e.quote.min_amount_out,
    "- floor: " + JSON.stringify(e.quote.floor_eval),
    "- deposit: `" + e.quote.deposit_address + "`",
    "- verify: " + JSON.stringify(e.quote.verify),
    "",
    "## Gas / MPC tx compatibility",
    "",
    "- eth_gasPrice=" +
      e.gas.eth_gasPrice_wei +
      " wei (" +
      e.gas.eth_gasPrice_gwei +
      " gwei)",
    "- estimate=" +
      e.gas.estimate.gas +
      " (" +
      e.gas.estimate.method +
      ")",
    "- chosen: " + JSON.stringify(e.gas.chosen),
    "",
    "## Local simulation",
    "",
    "- attestation ok=" +
      e.attestation.ok +
      " local_sig=" +
      e.attestation.local_sig_ok,
    "- policy sim ok=" + e.local_simulation.policy?.ok,
    "- path_ok=" + e.local_simulation.path_ok,
    "- on_chain_mutated=" + e.local_simulation.on_chain_state_mutated,
    "- digest binding: " +
      JSON.stringify(e.local_simulation.tx_bundle?.digest_binding || null),
    "",
    "## J8B execution blockers (expected until owner unlocks)",
    "",
    ...(e.blockers_for_j8b_execution || []).map((x) => "- " + x),
    "",
    "## J8B operator runbook (summary)",
    "",
    "### Ledger",
    ...(runbook.ledger_actions || []).map(
      (s) =>
        "- " +
        s.step +
        ": " +
        s.method +
        " " +
        JSON.stringify(s.args) +
        " — " +
        (s.purpose || "")
    ),
    "",
    "### Agent",
    ...(runbook.agent_calls || []).map(
      (s) => "- " + s.step + ": " + s.action
    ),
    "",
    "Full runbook JSON: see MAINNET_CHECKPOINT_J8A.json → j8b_runbook",
    "",
    "## Mutations this checkpoint",
    "",
    "```json",
    JSON.stringify(e.mutations, null, 2),
    "```",
    "",
  ];
  return lines.join("\n");
}

async function main() {
  const preflight = await runJ8aPreflight();
  const runbook = buildJ8bRunbook(preflight);
  const evidence = sanitize({
    ...preflight,
    j8b_runbook: runbook,
    safety: {
      unpause: false,
      propose: false,
      request_signature: false,
      broadcast: false,
      escrow_deposit: false,
      autonomous: false,
      new_funding: false,
      contract_upgrade: false,
      mock_success: false,
      secrets_in_evidence: false,
    },
  });

  writeFileSync(
    join(OUT, "MAINNET_CHECKPOINT_J8A.json"),
    JSON.stringify(evidence, null, 2)
  );
  writeFileSync(
    join(OUT, "MAINNET_CHECKPOINT_J8A.md"),
    renderMd(evidence, runbook)
  );

  console.log(
    JSON.stringify(
      {
        preflight: evidence.go_no_go.preflight,
        execution: evidence.go_no_go.execution,
        funding_ok: evidence.funding.ok,
        quote_ok: evidence.quote.ok,
        attest_ok: evidence.attestation.ok,
        path_ok: evidence.local_simulation.path_ok,
        gas_ok: evidence.gas.chosen?.ok,
        blockers: evidence.blockers_for_j8b_execution,
        arb_eth: evidence.funding.balances.arbitrum.eth,
        arb_usdc: evidence.funding.balances.arbitrum.usdc,
        deposit: evidence.quote.deposit_address,
        min_out: evidence.quote.min_amount_out,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
