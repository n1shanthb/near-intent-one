#!/usr/bin/env node
/**
 * Mission 1 operator CLI — Ethereum USDC → NEAR NEP-141.
 * Independent of J8B Arb canary-operator. One phase per invocation.
 *
 * Default: dry / preview only. --invoke required for mutations.
 * HARD STOP: do not use --invoke without separate financial approval.
 *
 * Usage (PowerShell):
 *   node scripts/mainnet/mission1-operator.mjs capabilities
 *   node scripts/mainnet/mission1-operator.mjs dry-rehearsal
 *   node scripts/mainnet/mission1-operator.mjs prepare
 *   node scripts/mainnet/mission1-operator.mjs quote --op <id> [--allow-funded-quote]
 *   node scripts/mainnet/mission1-operator.mjs verify-unpaused --op <id>
 *   node scripts/mainnet/mission1-operator.mjs confirm --op <id> --phase propose|sign|broadcast|reconcile
 *   node scripts/mainnet/mission1-operator.mjs propose --op <id> [--invoke]
 *   node scripts/mainnet/mission1-operator.mjs sign --op <id> [--invoke]
 *   node scripts/mainnet/mission1-operator.mjs persist --op <id> [--raw <hex>]
 *   node scripts/mainnet/mission1-operator.mjs broadcast --op <id> [--invoke]
 *   node scripts/mainnet/mission1-operator.mjs settle --op <id>
 *   node scripts/mainnet/mission1-operator.mjs reconcile --op <id> [--invoke] [--evidence <hash>]
 *   node scripts/mainnet/mission1-operator.mjs verify-paused
 *   node scripts/mainnet/mission1-operator.mjs status --op <id>
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  mission1RunnerCapabilities,
  assertMission1RunnerComplete,
  listMission1RunnerSteps,
  mission1StepPrepareApproval,
  mission1StepQuoteAttest,
  mission1StepVerifyUnpaused,
  mission1StepPropose,
  mission1StepRequestSignature,
  mission1StepPersistSignedRaw,
  mission1StepBroadcast,
  mission1StepSettle,
  mission1StepReconcilePending,
  mission1StepVerifyPaused,
  recordMission1Confirmation,
  runMission1DryRehearsal,
} from "../../packages/mainnet/mission1Executor.mjs";
import {
  createMission1LiveAdapters,
  createMission1ViewAdapters,
} from "../../packages/mainnet/mission1Adapters.mjs";
import { mission1StoreDir } from "../../packages/mainnet/mission1ExecutionPath.mjs";
import { getLifecycleState } from "../../packages/mainnet/canaryOneShot.mjs";
import { openTxJournal } from "../../packages/execution/txJournal.mjs";
import { redactSecrets } from "../../packages/mainnet/agentCredentials.mjs";
import { homedir } from "node:os";

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

function refuseJ8bRoute() {
  if (flag("j8b") || flag("arbitrum") || arg("via") === "j8b") {
    return {
      ok: false,
      reason: "mission1_refuses_j8b_operator_route",
      note: "Use this CLI only; never route Eth txs through Arb J8B operator",
    };
  }
  return null;
}

async function main() {
  const blocked = refuseJ8bRoute();
  if (blocked) {
    console.log(JSON.stringify(blocked, null, 2));
    process.exitCode = 2;
    return;
  }

  if (cmd === "help" || cmd === "-h") {
    console.log(`Mission 1 Eth→NEAR operator (independent of J8B)

Commands:
  capabilities | steps | assert-ready
  dry-rehearsal [--allow-funded-quote]
  prepare
  quote --op <id> [--allow-funded-quote]
  verify-unpaused --op <id>
  confirm --op <id> --phase propose|sign|broadcast|reconcile
  propose --op <id> [--invoke]
  sign --op <id> [--invoke]
  persist --op <id> [--raw <hex>]
  broadcast --op <id> [--invoke]
  settle --op <id>
  reconcile --op <id> [--invoke] [--evidence <hash>]
  verify-paused
  status --op <id>

HARD STOP without financial approval: never pass --invoke for live mutations.
`);
    return;
  }

  if (cmd === "capabilities") {
    console.log(JSON.stringify(mission1RunnerCapabilities(), null, 2));
    return;
  }
  if (cmd === "steps") {
    console.log(JSON.stringify(listMission1RunnerSteps(), null, 2));
    return;
  }
  if (cmd === "assert-ready") {
    console.log(JSON.stringify(assertMission1RunnerComplete(), null, 2));
    return;
  }

  if (cmd === "dry-rehearsal") {
    const r = await runMission1DryRehearsal({
      operationId: op || undefined,
      allowFundedQuote: flag("allow-funded-quote"),
      // Live read-only adapters; no fixtures
      adapters: await createMission1ViewAdapters({}),
    });
    console.log(JSON.stringify(redactSecrets(r), null, 2));
    if (!r.ok) process.exitCode = 1;
    return;
  }

  if (cmd === "prepare") {
    const r = mission1StepPrepareApproval({ operationId: op || undefined });
    console.log(JSON.stringify(redactSecrets(r), null, 2));
    return;
  }

  if (cmd === "quote") {
    if (!op) throw new Error("--op required");
    const adapters = await createMission1ViewAdapters({});
    const r = await mission1StepQuoteAttest({
      operationId: op,
      adapters,
      allowFundedQuote: flag("allow-funded-quote"),
    });
    console.log(JSON.stringify(redactSecrets(r), null, 2));
    if (!r.ok) process.exitCode = 1;
    return;
  }

  if (cmd === "verify-unpaused") {
    if (!op) throw new Error("--op required");
    const adapters = await createMission1ViewAdapters({});
    const r = await mission1StepVerifyUnpaused({ operationId: op, adapters });
    console.log(JSON.stringify(redactSecrets(r), null, 2));
    if (!r.ok) process.exitCode = 1;
    return;
  }

  if (cmd === "confirm") {
    if (!op) throw new Error("--op required");
    const phase = arg("phase");
    if (!phase) throw new Error("--phase required");
    const r = recordMission1Confirmation(op, phase, {
      note: arg("note") || `cli_confirm_${phase}`,
    });
    console.log(JSON.stringify(redactSecrets(r), null, 2));
    if (!r.ok) process.exitCode = 1;
    return;
  }

  if (cmd === "propose") {
    if (!op) throw new Error("--op required");
    const adapters = invoke
      ? await createMission1LiveAdapters({})
      : await createMission1ViewAdapters({});
    const r = await mission1StepPropose({
      operationId: op,
      invoke,
      adapters,
    });
    console.log(JSON.stringify(redactSecrets(r), null, 2));
    if (!r.ok) process.exitCode = 1;
    return;
  }

  if (cmd === "sign") {
    if (!op) throw new Error("--op required");
    const adapters = invoke
      ? await createMission1LiveAdapters({})
      : await createMission1ViewAdapters({});
    const r = await mission1StepRequestSignature({
      operationId: op,
      invoke,
      adapters,
    });
    console.log(JSON.stringify(redactSecrets(r), null, 2));
    if (!r.ok) process.exitCode = 1;
    return;
  }

  if (cmd === "persist") {
    if (!op) throw new Error("--op required");
    const journal = openTxJournal({
      path: join(homedir(), ".nio-secure", "mainnet-mission1", "tx.sqlite"),
      secret: process.env.NIO_JOURNAL_SECRET,
    });
    const r = mission1StepPersistSignedRaw({
      operationId: op,
      signedRawHex: arg("raw"),
      deps: { journal },
    });
    console.log(JSON.stringify(redactSecrets(r), null, 2));
    if (!r.ok) process.exitCode = 1;
    return;
  }

  if (cmd === "broadcast") {
    if (!op) throw new Error("--op required");
    const adapters = invoke
      ? await createMission1LiveAdapters({})
      : await createMission1ViewAdapters({});
    const journal = openTxJournal({
      path: join(homedir(), ".nio-secure", "mainnet-mission1", "tx.sqlite"),
      secret: process.env.NIO_JOURNAL_SECRET,
    });
    const r = await mission1StepBroadcast({
      operationId: op,
      invoke,
      adapters,
      deps: { journal },
    });
    console.log(JSON.stringify(redactSecrets(r), null, 2));
    if (!r.ok) process.exitCode = 1;
    return;
  }

  if (cmd === "settle") {
    if (!op) throw new Error("--op required");
    const r = await mission1StepSettle({ operationId: op });
    console.log(JSON.stringify(redactSecrets(r), null, 2));
    if (!r.ok) process.exitCode = 1;
    return;
  }

  if (cmd === "reconcile") {
    if (!op) throw new Error("--op required");
    const adapters = invoke
      ? await createMission1LiveAdapters({})
      : await createMission1ViewAdapters({});
    const r = await mission1StepReconcilePending({
      operationId: op,
      invoke,
      adapters,
      evidenceHash: arg("evidence"),
    });
    console.log(JSON.stringify(redactSecrets(r), null, 2));
    if (!r.ok) process.exitCode = 1;
    return;
  }

  if (cmd === "verify-paused") {
    const adapters = await createMission1ViewAdapters({});
    const r = await mission1StepVerifyPaused({ adapters });
    console.log(JSON.stringify(redactSecrets(r), null, 2));
    if (!r.ok) process.exitCode = 1;
    return;
  }

  if (cmd === "status") {
    if (!op) throw new Error("--op required");
    const sd = mission1StoreDir(process.env);
    const path = join(sd, `${op}.json`);
    if (!existsSync(path)) {
      console.log(JSON.stringify({ ok: false, reason: "approval_not_found" }, null, 2));
      process.exitCode = 1;
      return;
    }
    const record = JSON.parse(readFileSync(path, "utf8"));
    console.log(
      JSON.stringify(
        {
          ok: true,
          operation_id: op,
          lifecycle: getLifecycleState(record),
          used: Boolean(record.used),
          confirmations: record.operator_confirmations || {},
          chain_id: record.payload?.chain_id,
          token: record.payload?.token_contract,
        },
        null,
        2
      )
    );
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
