#!/usr/bin/env node
/**
 * Mainnet policy deploy — HARD GATED.
 * Refuses unless approval file matches wasm sha256 + max NEAR + approved:true.
 * Does not run unless --execute is passed after approval.
 *
 * Without --execute: prints plan only.
 */
import { readFileSync, existsSync } from "node:fs";
import { sha256File, DEFAULT_WASM } from "../../packages/mainnet/deploy.mjs";
import { MAINNET } from "../../packages/networks/profiles.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return def;
}

const execute = process.argv.includes("--execute");
const account = arg("account");
const wasmPath = arg("wasm", DEFAULT_WASM);
const expectedSha = arg("sha256");
const maxNear = arg("max-near");
const approvalFile = arg("approve-file");

if (!account || !expectedSha || !maxNear || !approvalFile) {
  console.error(
    "usage: node scripts/mainnet/deploy-policy.mjs --account X.near --sha256 HEX --max-near N --approve-file PATH [--execute]"
  );
  process.exit(1);
}

if (!existsSync(wasmPath)) {
  console.error("wasm missing:", wasmPath);
  process.exit(1);
}
const artifact = sha256File(wasmPath);
if (artifact.sha256 !== expectedSha) {
  console.error("sha256 mismatch", { expected: expectedSha, actual: artifact.sha256 });
  process.exit(1);
}

if (!existsSync(approvalFile)) {
  console.error("approval file missing:", approvalFile);
  process.exit(1);
}
const approval = JSON.parse(readFileSync(approvalFile, "utf8"));
const checks = [];
if (approval.approved !== true) checks.push("approved_not_true");
if (approval.target_account !== account) checks.push("target_mismatch");
if (approval.wasm_sha256 !== expectedSha) checks.push("hash_mismatch");
if (String(approval.max_near) !== String(maxNear)) checks.push("max_near_mismatch");
if (!approval.approver) checks.push("approver_missing");
if (!approval.approved_at) checks.push("approved_at_missing");
if (approval.mpc_signer && approval.mpc_signer !== MAINNET.mpc.signer) {
  checks.push("mpc_signer_mismatch");
}

const plan = {
  network: "mainnet",
  action: "deploy_contract + new(...)",
  account,
  wasm: artifact,
  max_near: maxNear,
  mpc_signer: MAINNET.mpc.signer,
  approval_checks: checks,
  execute,
  status:
    checks.length === 0
      ? execute
        ? "WOULD_DEPLOY"
        : "APPROVED_AWAITING_EXECUTE"
      : "BLOCKED",
};

console.log(JSON.stringify(plan, null, 2));

if (checks.length) {
  process.exit(2);
}

if (!execute) {
  console.error(
    "\nApproval OK for plan. Re-run with --execute ONLY after operator confirms. Broadcast not implemented in this gate until near-cli/credentials path is operator-supplied."
  );
  process.exit(0);
}

// Explicit: do not auto-broadcast even with --execute until credentials wiring is approved.
console.error(
  JSON.stringify({
    ok: false,
    reason: "deploy_broadcast_not_enabled",
    detail:
      "Approval matched, but this script refuses to broadcast without a follow-up operator commit that supplies mainnet deployer credentials path. No funds spent.",
    status: "NOT_YET_PROVEN",
  })
);
process.exit(3);
