/**
 * J8B-0 — Ledger unpause()/pause() preview (DO NOT EXECUTE in this checkpoint).
 * Deployed contract methods are unpause() and pause() — NOT set_paused().
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { MAINNET_IDENTITIES } from "./identities.mjs";

export function defaultNearCliPath() {
  return (
    process.env.NIO_NEAR_CLI ||
    join(
      homedir(),
      "bin",
      "near-cli-rs",
      "near-cli-rs-x86_64-pc-windows-msvc",
      "near.exe"
    )
  );
}

export const LEDGER_HD = "m/44'/397'/0'/0'/1'";

/**
 * Write empty-args JSON files for Near CLI file-args (Windows-safe).
 */
export function writeLedgerArgFiles(dir) {
  mkdirSync(dir, { recursive: true });
  const unpause = join(dir, "unpause.args.json");
  const pause = join(dir, "pause.args.json");
  writeFileSync(unpause, "{}\n");
  writeFileSync(pause, "{}\n");
  return { unpause, pause };
}

export function buildLedgerRunbook({
  nearCli = defaultNearCliPath(),
  argsDir = join(homedir(), ".nio-secure", "mainnet-canary"),
  hdPath = LEDGER_HD,
} = {}) {
  const files = writeLedgerArgFiles(argsDir);
  const unpauseCmd = `# DO NOT RUN until J8B live execution approved
# Method: unpause() — opens agent propose/sign window
$near = "${nearCli}"
$HD = "${hdPath}"
$NioArgsFile = "${files.unpause}"

& $near contract call-function as-transaction ${MAINNET_IDENTITIES.policy} unpause file-args $NioArgsFile \`
  prepaid-gas '30.0 Tgas' \`
  attached-deposit '0 NEAR' \`
  sign-as ${MAINNET_IDENTITIES.owner} \`
  network-config mainnet \`
  sign-with-ledger --seed-phrase-hd-path $HD \`
  usb
`;

  const pauseCmd = `# EMERGENCY / post-canary close window
# Method: pause() — does NOT cancel already-signed or broadcast EVM txs
$near = "${nearCli}"
$HD = "${hdPath}"
$NioArgsFile = "${files.pause}"

& $near contract call-function as-transaction ${MAINNET_IDENTITIES.policy} pause file-args $NioArgsFile \`
  prepaid-gas '30.0 Tgas' \`
  attached-deposit '0 NEAR' \`
  sign-as ${MAINNET_IDENTITIES.owner} \`
  network-config mainnet \`
  sign-with-ledger --seed-phrase-hd-path $HD \`
  usb
`;

  const viewPaused = `& "${nearCli}" contract call-function as-read-only ${MAINNET_IDENTITIES.policy} get_paused json-args "{}" network-config mainnet now`;

  return {
    contract_methods: {
      open_window: "unpause",
      close_window: "pause",
      incorrect_do_not_use: "set_paused",
      reconcile: "reconcile_pending",
    },
    signer: MAINNET_IDENTITIES.owner,
    receiver: MAINNET_IDENTITIES.policy,
    hd_path: hdPath,
    args_files: files,
    unpause_command: unpauseCmd,
    pause_command: pauseCmd,
    view_paused_command: viewPaused,
    residual_risk_notes: [
      "pause() or remove_trusted_quote_signer does NOT invalidate an EVM tx already MPC-signed or broadcast",
      "If MPC signature exists without confirmed broadcast: retain durable journal; operator reconciliation only; never auto-resign",
      "Do not generate a replacement transaction at the same nonce without owner cancel path",
      "reconcile_pending requires owner or configured reconciler — never auto set_reconciler",
    ],
    executed: false,
  };
}

/**
 * Owner/reconciler Ledger command for reconcile_pending — never agent unless get_reconciler==agent.
 */
export function buildReconcileLedgerCommand({
  operationId,
  settlementState = "Success",
  evidenceHash,
  nearCli = defaultNearCliPath(),
  argsDir = join(homedir(), ".nio-secure", "mainnet-canary"),
  hdPath = LEDGER_HD,
  signAs = MAINNET_IDENTITIES.owner,
} = {}) {
  if (!operationId || !evidenceHash) {
    return { ok: false, reason: "operation_id_and_evidence_hash_required" };
  }
  mkdirSync(argsDir, { recursive: true });
  const argsPath = join(argsDir, `reconcile-${operationId}.args.json`);
  writeFileSync(
    argsPath,
    JSON.stringify(
      {
        operation_id: operationId,
        settlement_state: settlementState,
        evidence_hash: String(evidenceHash),
      },
      null,
      2
    ) + "\n"
  );
  const cmd = `# OWNER/RECONCILER reconcile_pending — DO NOT run agent-signed if get_reconciler != agent
$near = "${nearCli}"
$HD = "${hdPath}"
$NioArgsFile = "${argsPath}"

& $near contract call-function as-transaction ${MAINNET_IDENTITIES.policy} reconcile_pending file-args $NioArgsFile \`
  prepaid-gas '50.0 Tgas' \`
  attached-deposit '0 NEAR' \`
  sign-as ${signAs} \`
  network-config mainnet \`
  sign-with-ledger --seed-phrase-hd-path $HD \`
  usb
`;
  const viewPending = `& "${nearCli}" contract call-function as-read-only ${MAINNET_IDENTITIES.policy} get_pending json-args "{\\"operation_id\\":\\"${operationId}\\"}" network-config mainnet now`;
  return {
    ok: true,
    method: "reconcile_pending",
    sign_as: signAs,
    args_file: argsPath,
    command: cmd,
    view_pending_command: viewPending,
    executed: false,
  };
}
