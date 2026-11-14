#!/usr/bin/env node
/**
 * Mission 2 operator CLI — Base USDC → NEAR NEP-141.
 * Independent of J8B Arb and Mission 1 Eth. One phase per invocation.
 *
 * Default: dry / preview only. --invoke required for mutations.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  mission2RunnerCapabilities,
  assertMission2RunnerComplete,
  listMission2RunnerSteps,
  mission2StepPrepareApproval,
  mission2StepQuoteAttest,
  mission2StepVerifyUnpaused,
  mission2StepPropose,
  mission2StepRequestSignature,
  mission2StepPersistSignedRaw,
  mission2StepBroadcast,
  mission2StepSettle,
  mission2StepReconcilePending,
  mission2StepVerifyPaused,
  recordMission2Confirmation,
  runMission2DryRehearsal,
} from "../../packages/mainnet/mission2Executor.mjs";
import {
  createMission2LiveAdapters,
  createMission2ViewAdapters,
} from "../../packages/mainnet/mission2Adapters.mjs";
import {
  mission2StoreDir,
  MISSION2_LIVE_AMOUNT_CAP,
} from "../../packages/mainnet/mission2ExecutionPath.mjs";
import {
  getLifecycleState,
  CANARY_ATTESTOR_PK,
} from "../../packages/mainnet/canaryOneShot.mjs";
import { openTxJournal } from "../../packages/execution/txJournal.mjs";
import { redactSecrets } from "../../packages/mainnet/agentCredentials.mjs";
import { publicKeyEd25519 } from "../../packages/intents-codec/quote-auth.mjs";

function loadMission2Attestor() {
  const latest = join(
    homedir(),
    ".nio-secure",
    "mainnet-attestor",
    "LATEST_ATTESTOR_PATH.txt"
  );
  if (!existsSync(latest)) throw new Error("attestor_not_generated");
  const seedPath = readFileSync(latest, "utf8").trim();
  const seed = JSON.parse(readFileSync(seedPath, "utf8"));
  const sk = Buffer.from(seed.secretKey64, "base64");
  const pk = publicKeyEd25519(sk);
  if (pk !== seed.publicKey || pk !== CANARY_ATTESTOR_PK) {
    throw new Error("attestor_key_mismatch");
  }
  return { publicKey: pk, secretKey64: sk };
}

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

function refuseForeignRoutes() {
  if (flag("j8b") || flag("arbitrum") || arg("via") === "j8b") {
    return {
      ok: false,
      reason: "mission2_refuses_j8b_operator_route",
      note: "Use mission2-operator only — never J8B Arb canary operator",
    };
  }
  if (flag("eth") || flag("ethereum") || arg("via") === "mission1" || arg("via") === "eth") {
    return {
      ok: false,
      reason: "mission2_refuses_eth_operator_route",
      note: "Use mission1-operator for Eth→NEAR; this CLI is Base→NEAR only",
    };
  }
  return null;
}

async function main() {
  const blocked = refuseForeignRoutes();
  if (blocked) {
    console.log(JSON.stringify(blocked, null, 2));
    process.exitCode = 2;
    return;
  }

  if (cmd === "help" || cmd === "-h") {
    console.log(`Mission 2 Base→NEAR operator (independent of J8B / Mission1 Eth)

Commands:
  capabilities | steps | assert-ready
  dry-rehearsal [--allow-funded-quote]
  prepare [--amount <raw_usdc>]
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
    console.log(JSON.stringify(mission2RunnerCapabilities(), null, 2));
    return;
  }
  if (cmd === "steps") {
    console.log(JSON.stringify(listMission2RunnerSteps(), null, 2));
    return;
  }
  if (cmd === "assert-ready") {
    console.log(JSON.stringify(assertMission2RunnerComplete(), null, 2));
    return;
  }

  if (cmd === "dry-rehearsal") {
    const r = await runMission2DryRehearsal({
      operationId: op || undefined,
      allowFundedQuote: flag("allow-funded-quote"),
      adapters: await createMission2ViewAdapters({}),
    });
    console.log(JSON.stringify(redactSecrets(r), null, 2));
    if (!r.ok) process.exitCode = 1;
    return;
  }

  if (cmd === "prepare") {
    const ttlRaw = arg("ttl-ms");
    const r = mission2StepPrepareApproval({
      operationId: op || undefined,
      amount: arg("amount") || MISSION2_LIVE_AMOUNT_CAP,
      ttlMs: ttlRaw != null ? Number(ttlRaw) : undefined,
    });
    console.log(JSON.stringify(redactSecrets(r), null, 2));
    return;
  }

  if (cmd === "quote") {
    if (!op) throw new Error("--op required");
    const adapters = await createMission2ViewAdapters({});
    const attestor = loadMission2Attestor();
    const r = await mission2StepQuoteAttest({
      operationId: op,
      adapters,
      allowFundedQuote: flag("allow-funded-quote"),
      deps: { attestor },
    });
    console.log(JSON.stringify(redactSecrets(r), null, 2));
    if (!r.ok) process.exitCode = 1;
    return;
  }

  if (cmd === "verify-unpaused") {
    if (!op) throw new Error("--op required");
    const adapters = await createMission2ViewAdapters({});
    const r = await mission2StepVerifyUnpaused({ operationId: op, adapters });
    console.log(JSON.stringify(redactSecrets(r), null, 2));
    if (!r.ok) process.exitCode = 1;
    return;
  }

  if (cmd === "confirm") {
    if (!op) throw new Error("--op required");
    const phase = arg("phase");
    if (!phase) throw new Error("--phase required");
    const r = recordMission2Confirmation(op, phase, {
      note: arg("note") || `cli_confirm_${phase}`,
    });
    console.log(JSON.stringify(redactSecrets(r), null, 2));
    if (!r.ok) process.exitCode = 1;
    return;
  }

  if (cmd === "propose") {
    if (!op) throw new Error("--op required");
    const adapters = invoke
      ? await createMission2LiveAdapters({})
      : await createMission2ViewAdapters({});
    const r = await mission2StepPropose({
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
      ? await createMission2LiveAdapters({})
      : await createMission2ViewAdapters({});
    const r = await mission2StepRequestSignature({
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
      path: join(homedir(), ".nio-secure", "mainnet-mission2", "tx.sqlite"),
      secret: process.env.NIO_JOURNAL_SECRET,
    });
    const r = mission2StepPersistSignedRaw({
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
      ? await createMission2LiveAdapters({})
      : await createMission2ViewAdapters({});
    const journal = openTxJournal({
      path: join(homedir(), ".nio-secure", "mainnet-mission2", "tx.sqlite"),
      secret: process.env.NIO_JOURNAL_SECRET,
    });
    const r = await mission2StepBroadcast({
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
    const adapters = await createMission2ViewAdapters({});
    const r = await mission2StepSettle({
      operationId: op,
      deps: { adapters, nearRpc: adapters.rpc },
    });
    console.log(JSON.stringify(redactSecrets(r), null, 2));
    if (!r.ok) process.exitCode = 1;
    return;
  }

  if (cmd === "reconcile") {
    if (!op) throw new Error("--op required");
    const adapters = invoke
      ? await createMission2LiveAdapters({})
      : await createMission2ViewAdapters({});
    const r = await mission2StepReconcilePending({
      operationId: op,
      invoke,
      adapters,
      evidenceHash: arg("evidence"),
      deps: flag("ledger-done") ? { ledgerReconcileDone: true } : {},
    });
    console.log(JSON.stringify(redactSecrets(r), null, 2));
    if (!r.ok) process.exitCode = 1;
    return;
  }

  if (cmd === "verify-paused") {
    const adapters = await createMission2ViewAdapters({});
    const r = await mission2StepVerifyPaused({ adapters });
    console.log(JSON.stringify(redactSecrets(r), null, 2));
    if (!r.ok) process.exitCode = 1;
    return;
  }

  if (cmd === "status") {
    if (!op) throw new Error("--op required");
    const sd = mission2StoreDir(process.env);
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
          token: record.payload?.token,
          amount: record.payload?.amount,
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