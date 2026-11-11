#!/usr/bin/env node
/**
 * Mainnet MVP readiness — builds approval stub, hashes WASM, probes v1.signer.
 * Never deploys. Never signs. Never spends.
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDeploymentApprovalRequest,
  buildInitArgs,
  writeApprovalStub,
  DEFAULT_WASM,
  sha256File,
} from "../../packages/mainnet/deploy.mjs";
import {
  mainnetMpcPublicKey,
  mainnetSignRequirements,
} from "../../packages/mainnet/mpc.mjs";
import { fetchProductionTokens } from "../../packages/mainnet/intents.mjs";
import { evaluateCanaryReadiness } from "../../packages/mainnet/canary.mjs";
import { mainnetAuthGates } from "../../packages/networks/profiles.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, "docs");
const APPROVALS = join(ROOT, "docs/approvals");

mkdirSync(APPROVALS, { recursive: true });

const target =
  process.env.NIO_MAINNET_POLICY_ACCOUNT || "nio-policy-hack26.near";
const owner = process.env.NIO_MAINNET_OWNER || "OWNER_ACCOUNT.near";
const agent = process.env.NIO_MAINNET_AGENT || "AGENT_ACCOUNT.near";
const portfolioId = process.env.NIO_MAINNET_PORTFOLIO_ID || "hack26-canary";

let initArgs = null;
try {
  if (owner.endsWith(".near") && !owner.includes("OWNER_ACCOUNT")) {
    initArgs = buildInitArgs({
      owner,
      agent,
      portfolio_id: portfolioId,
    });
  }
} catch (e) {
  initArgs = { error: String(e.message || e) };
}

const wasmInfo = existsSync(DEFAULT_WASM)
  ? sha256File(DEFAULT_WASM)
  : { missing: true, path: DEFAULT_WASM };

const approvalReq = buildDeploymentApprovalRequest({
  targetAccount: target,
  initArgs: initArgs && !initArgs.error ? initArgs : undefined,
  maxNear: process.env.NIO_MAINNET_MAX_NEAR || "15",
});

const stubPath = join(APPROVALS, "MAINNET_DEPLOY_APPROVAL.json");
writeApprovalStub(stubPath, approvalReq);

let mpc = null;
try {
  mpc = await mainnetMpcPublicKey();
} catch (e) {
  mpc = { ok: false, error: String(e.message || e), status: "NOT_YET_PROVEN" };
}

let tokens = null;
try {
  tokens = await fetchProductionTokens();
} catch (e) {
  tokens = { ok: false, error: String(e.message || e) };
}

const canary = evaluateCanaryReadiness({
  testnetLifecycleOk: false,
  policyDeployed: false,
  ledgerOwned: false,
});

const report = {
  generated_at: new Date().toISOString(),
  gates: mainnetAuthGates(),
  wasm: wasmInfo,
  deployment_approval_request: approvalReq,
  approval_stub: stubPath,
  mpc,
  sign_requirements: mainnetSignRequirements(),
  intents_tokens: tokens?.ok
    ? { ok: true, count: tokens.count, status: tokens.status_label }
    : tokens,
  canary,
  labels: {
    contract: "IMPLEMENTED — DEPLOY AWAITING APPROVAL",
    mpc_root_key: mpc?.public_key ? "VERIFIED_ON_MAINNET_READ" : "NOT_YET_PROVEN",
    intents_registry: tokens?.ok ? "VERIFIED_ON_MAINNET_READ" : "NOT_YET_PROVEN",
    funded_execution: "NOT_YET_PROVEN",
  },
};

writeFileSync(
  join(OUT, "MAINNET_READINESS_SNAPSHOT.json"),
  JSON.stringify(report, null, 2)
);
console.log(JSON.stringify(report, null, 2));
