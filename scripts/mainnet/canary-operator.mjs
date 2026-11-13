#!/usr/bin/env node
/**
 * J8B-1 operator CLI — one phase per invocation. Never runs the full financial sequence.
 *
 * Usage (PowerShell):
 *   node scripts/mainnet/canary-operator.mjs prepare
 *   node scripts/mainnet/canary-operator.mjs quote --op <id>
 *   node scripts/mainnet/canary-operator.mjs show-unpause
 *   node scripts/mainnet/canary-operator.mjs verify-unpaused --op <id>
 *   node scripts/mainnet/canary-operator.mjs confirm --op <id> --phase propose
 *   node scripts/mainnet/canary-operator.mjs propose --op <id> --invoke   # LIVE
 *   ...
 *
 * Default: dry / preview only. --invoke required for mutations.
 */
import {
  prepareCanaryOperation,
  canaryStepQuoteAttest,
  canaryStepVerifyUnpaused,
  canaryStepPropose,
  canaryStepRequestSignature,
  canaryStepBroadcast,
  canaryStepSettle,
  canaryStepReconcilePending,
  canaryStepVerifyPaused,
  runCanaryDryRehearsal,
} from "../../packages/mainnet/canaryExecutor.mjs";
import {
  confirmPhaseAfterOutcome,
  loadCanaryApproval,
  loadRecoveryAuthorization,
  CANARY_STATES,
} from "../../packages/mainnet/canaryOneShot.mjs";
import { buildLedgerRunbook } from "../../packages/mainnet/canaryLedgerRunbook.mjs";
import {
  inspectReservedOperation,
  createRecoveryAuthorization,
  runRecoveryRehearsal,
} from "../../packages/mainnet/canaryRecovery.mjs";
import { redactSecrets } from "../../packages/mainnet/agentCredentials.mjs";

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return def;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

const cmd = process.argv[2] || "help";
const op = arg("op");
const invoke = flag("invoke");

async function main() {
  if (cmd === "help" || cmd === "-h") {
    console.log(`Commands:
  prepare
  quote --op <id>
  show-unpause | show-pause
  verify-unpaused --op <id>
  confirm --op <id> --phase propose|sign|broadcast
  propose --op <id> [--invoke]
  sign --op <id> [--invoke]
  broadcast --op <id> [--invoke]
  settle --op <id>
  confirm --op <id> --phase reconcile
  reconcile --op <id> [--invoke] [--evidence <hash>]
  verify-paused
  status --op <id>
  dry-rehearsal [--op <id>]
  inspect --op <id> [--near-tx <hash>]
  recovery-rehearsal --op <id> [--near-tx <hash>]
  create-recovery-auth --op <id> [--near-tx <hash>] [--confirm-recovery]
  show-abort --op <id>
`);
    return;
  }

  if (cmd === "dry-rehearsal") {
    const r = await runCanaryDryRehearsal({ operationId: op || undefined });
    console.log(JSON.stringify(redactSecrets(r), null, 2));
    return;
  }

  if (cmd === "inspect") {
    if (!op) throw new Error("--op required");
    const r = await inspectReservedOperation({
      operationId: op,
      nearProposeTx: arg("near-tx"),
    });
    console.log(JSON.stringify(redactSecrets(r), null, 2));
    return;
  }

  if (cmd === "recovery-rehearsal") {
    if (!op) throw new Error("--op required");
    const r = await runRecoveryRehearsal({
      operationId: op,
      nearProposeTx: arg("near-tx"),
    });
    console.log(JSON.stringify(redactSecrets(r), null, 2));
    return;
  }

  if (cmd === "create-recovery-auth") {
    if (!op) throw new Error("--op required");
    const r = await createRecoveryAuthorization({
      operationId: op,
      nearProposeTx: arg("near-tx"),
      operatorConfirmed: flag("confirm-recovery"),
    });
    console.log(JSON.stringify(redactSecrets(r), null, 2));
    return;
  }

  if (cmd === "show-abort") {
    if (!op) throw new Error("--op required");
    const r = await inspectReservedOperation({
      operationId: op,
      nearProposeTx: arg("near-tx"),
    });
    console.log(r.abort_ledger?.command || JSON.stringify(r.abort_ledger, null, 2));
    console.log("\n# DO NOT RUN unless aborting the reserved PendingOp");
    console.log(r.abort_ledger?.view_pending_command || "");
    return;
  }

  if (cmd === "prepare") {
    const r = await prepareCanaryOperation({});
    console.log(JSON.stringify(redactSecrets(r), null, 2));
    return;
  }

  if (cmd === "show-unpause" || cmd === "show-pause") {
    const rb = buildLedgerRunbook();
    console.log(cmd === "show-unpause" ? rb.unpause_command : rb.pause_command);
    console.log("\n# Then verify:");
    console.log(rb.view_paused_command);
    return;
  }

  if (cmd === "status") {
    if (!op) throw new Error("--op required");
    const loaded = loadCanaryApproval(op);
    const recovery = loadRecoveryAuthorization(op);
    console.log(
      JSON.stringify(
        redactSecrets({ original: loaded, recovery }),
        null,
        2
      )
    );
    return;
  }

  if (cmd === "quote") {
    if (!op) throw new Error("--op required");
    const r = await canaryStepQuoteAttest({ operationId: op });
    console.log(JSON.stringify(redactSecrets(r), null, 2));
    return;
  }

  if (cmd === "verify-unpaused") {
    if (!op) throw new Error("--op required");
    const r = await canaryStepVerifyUnpaused({ operationId: op });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (cmd === "confirm") {
    if (!op) throw new Error("--op required");
    const phase = arg("phase");
    if (!phase) throw new Error("--phase required");
    const required = {
      propose: CANARY_STATES.OWNER_UNPAUSED,
      sign: CANARY_STATES.PROPOSED,
      broadcast: CANARY_STATES.READY_TO_BROADCAST,
      reconcile: CANARY_STATES.SETTLED,
    }[phase];
    const r = confirmPhaseAfterOutcome(op, phase, { requiredState: required });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (cmd === "propose") {
    if (!op) throw new Error("--op required");
    const r = await canaryStepPropose({ operationId: op, invoke });
    console.log(JSON.stringify(redactSecrets(r), null, 2));
    return;
  }

  if (cmd === "sign") {
    if (!op) throw new Error("--op required");
    const r = await canaryStepRequestSignature({ operationId: op, invoke });
    console.log(JSON.stringify(redactSecrets(r), null, 2));
    return;
  }

  if (cmd === "broadcast") {
    if (!op) throw new Error("--op required");
    const r = await canaryStepBroadcast({ operationId: op, invoke });
    console.log(JSON.stringify(redactSecrets(r), null, 2));
    return;
  }

  if (cmd === "settle") {
    if (!op) throw new Error("--op required");
    const r = await canaryStepSettle({ operationId: op });
    console.log(JSON.stringify(redactSecrets(r), null, 2));
    return;
  }

  if (cmd === "reconcile") {
    if (!op) throw new Error("--op required");
    const r = await canaryStepReconcilePending({
      operationId: op,
      invoke,
      evidenceHash: arg("evidence"),
    });
    console.log(JSON.stringify(redactSecrets(r), null, 2));
    return;
  }

  if (cmd === "verify-paused") {
    const r = await canaryStepVerifyPaused({});
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  throw new Error(`unknown_command:${cmd}`);
}

main().catch((e) => {
  console.error(String(e.message || e));
  process.exit(1);
});
