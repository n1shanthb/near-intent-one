#!/usr/bin/env node
/**
 * Checkpoint J8B-0 — implement one-shot canary executor (NO live mutations).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { prepareCanaryOperation } from "../../packages/mainnet/canaryExecutor.mjs";
import { buildLedgerRunbook } from "../../packages/mainnet/canaryLedgerRunbook.mjs";
import {
  mainnetExecutionGates,
  assertMainnetBroadcastAllowed,
} from "../../packages/mainnet/safetyGates.mjs";
import { MAINNET_IDENTITIES } from "../../packages/mainnet/identities.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, "docs/evidence");
mkdirSync(OUT, { recursive: true });

async function main() {
  const at = new Date().toISOString();
  const gates = mainnetExecutionGates(process.env);
  const blocked = assertMainnetBroadcastAllowed(process.env);

  // Create a real approval artifact outside the repo (not executed).
  const prep = await prepareCanaryOperation({
    operationId: `j8b0-wire-${Date.now()}`,
    storeDir: join(homedir(), ".nio-secure", "mainnet-canary"),
  });

  const ledger = buildLedgerRunbook({
    argsDir: join(homedir(), ".nio-secure", "mainnet-canary"),
  });

  const evidence = {
    checkpoint: "J8B-0",
    at,
    safety: {
      ledger_executed: false,
      unpause: false,
      pause: false,
      propose: false,
      request_signature: false,
      broadcast: false,
      escrow_transfer: false,
      new_funding: false,
      autonomous: false,
      secrets_in_evidence: false,
    },
    identities: {
      owner: MAINNET_IDENTITIES.owner,
      policy: MAINNET_IDENTITIES.policy,
      agent: MAINNET_IDENTITIES.agent,
      mpc: MAINNET_IDENTITIES.mpc_evm_address,
      epoch: 2,
      attestor: "ed25519:6oqnd5mBShyMGGHCgrJEEEPtgAEsXzJEPfARf7Fc2CG9",
    },
    hard_blocker_fixes: [
      {
        issue: "set_paused does not exist",
        fix: "Ledger runbook uses unpause()/pause()",
        file: "packages/mainnet/canaryLedgerRunbook.mjs",
      },
      {
        issue: "safetyGates hard-false",
        fix: "Default remains hard-false; scoped one-shot canary unlock only via validated approval",
        file: "packages/mainnet/safetyGates.mjs",
      },
      {
        issue: "assertMainnetFundedAllowed always rejects",
        fix: "Allows only when canaryUnlock.mode===one_shot_canary with journal+deposit bind",
        file: "packages/execution/chainProfiles.mjs",
      },
      {
        issue: "agentRuntime requires paused=true",
        fix: "Preserved for observe agent; canary is separate CLI, not agent tick",
        file: "packages/mainnet/agentRuntime.mjs",
      },
      {
        issue: "mainnet-api-server observation-only",
        fix: "Preserved — canary execution is local CLI, not HTTP tick",
        file: "packages/services/mainnet-api-server.mjs",
      },
      {
        issue: "1Click status needs depositAddress",
        fix: "canarySettlement.monitorOneClickByDeposit uses GET /v0/status?depositAddress=",
        file: "packages/mainnet/canarySettlement.mjs",
      },
    ],
    gates_default: gates,
    broadcast_without_canary: blocked,
    approval_prep: {
      ok: prep.ok,
      operation_id: prep.operation_id,
      fingerprint: prep.fingerprint,
      expires_at: prep.expires_at,
      path: prep.path,
      note: "Approval created for wiring only — not consumed for live trade",
    },
    ledger_preview: ledger,
    readiness:
      gates.funded_trading === false &&
      gates.mainnet_broadcast_enabled === false &&
      gates.autonomous_execution_enabled === false &&
      blocked.ok === false &&
      prep.ok &&
      ledger.contract_methods.open_window === "unpause"
        ? "READY_FOR_J8B_OWNER_APPROVED_LIVE_EXECUTION_CHECKPOINT"
        : "NOT_READY_FOR_FIRST_LIVE_TRADE",
    next:
      "Next checkpoint: owner-approved first live execution with operator confirmation at each mutation (unpause → propose → sign → broadcast → settle → pause)",
  };

  writeFileSync(
    join(OUT, "MAINNET_CHECKPOINT_J8B0.json"),
    JSON.stringify(evidence, null, 2)
  );
  writeFileSync(
    join(OUT, "MAINNET_CHECKPOINT_J8B0.md"),
    renderMd(evidence)
  );

  console.log(
    JSON.stringify(
      {
        readiness: evidence.readiness,
        approval: prep.operation_id,
        gates_locked: !gates.funded_trading && !gates.mainnet_broadcast_enabled,
        broadcast_blocked: !blocked.ok,
        ledger_methods: ledger.contract_methods,
      },
      null,
      2
    )
  );
}

function renderMd(e) {
  return [
    "# Checkpoint J8B-0 - One-shot mainnet canary executor wiring",
    "",
    "**NO Ledger / NO unpause / NO propose / NO request_signature / NO broadcast**",
    "",
    "## Readiness",
    "",
    "**" + e.readiness + "**",
    "",
    "## Default gates (must stay locked)",
    "",
    "```json",
    JSON.stringify(e.gates_default, null, 2),
    "```",
    "",
    "## Hard-blocker fixes",
    "",
    ...e.hard_blocker_fixes.map(
      (f) => "- **" + f.issue + "**: " + f.fix + " (`" + f.file + "`)"
    ),
    "",
    "## Ledger preview (DO NOT RUN)",
    "",
    "### unpause()",
    "```powershell",
    e.ledger_preview.unpause_command,
    "```",
    "",
    "### pause()",
    "```powershell",
    e.ledger_preview.pause_command,
    "```",
    "",
    "## Residual risk",
    "",
    ...e.ledger_preview.residual_risk_notes.map((n) => "- " + n),
    "",
    "## Next",
    "",
    e.next,
    "",
  ].join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
