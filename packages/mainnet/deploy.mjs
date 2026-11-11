/**
 * Mainnet policy WASM deployment readiness — does NOT broadcast.
 * Deployment proceeds only after explicit operator approval of:
 *   target account + artifact sha256 + max NEAR expenditure
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MAINNET, assertNetworkIsolation } from "../networks/profiles.mjs";
import { pickRpc, viewAccount, viewFunction } from "../networks/rpc.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_WASM = join(
  ROOT,
  "contracts/policy/target/wasm32-unknown-unknown/release/policy.wasm"
);

/** Rough storage-staking estimate helpers (yocto). Operator must set hard max. */
export const STORAGE_HINT = Object.freeze({
  /** Observed policy.wasm size ~ hundreds of KiB; pad for code + state. */
  recommended_min_near: "8",
  recommended_max_near_request: "15",
  note: "Exact cost depends on account creation vs upgrade; operator must approve max NEAR",
});

export function sha256File(path) {
  const buf = readFileSync(path);
  return {
    path,
    bytes: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex"),
  };
}

export function buildInitArgs({
  owner,
  agent,
  mpc_signer = MAINNET.mpc.signer,
  portfolio_id,
  verifying_contract = MAINNET.intents.verifier,
  limits,
}) {
  if (!owner?.endsWith(".near")) throw new Error("owner_must_be_mainnet");
  if (!agent?.endsWith(".near")) throw new Error("agent_must_be_mainnet");
  if (owner.startsWith(MAINNET.demoPrefix) || agent.startsWith(MAINNET.demoPrefix)) {
    throw new Error("demo_accounts_banned");
  }
  if (mpc_signer !== MAINNET.mpc.signer) {
    throw new Error(`mpc_signer_must_be_${MAINNET.mpc.signer}`);
  }
  return {
    owner,
    agent,
    mpc_signer,
    portfolio_id,
    verifying_contract,
    limits: limits || {
      max_trade_value: "1000000",
      daily_turnover_limit: "1000000",
      max_pending_exposure: "1000000",
      max_slippage_bps: 50,
      allowed_assets: ["native:near", "nep141:wrap.near"],
      allowed_destinations: [],
      valid_until: String(
        BigInt(Date.now()) * 1_000_000n + 30n * 24n * 3600n * 1_000_000_000n
      ),
      token_scope: "allowlist",
      allowed_chains: ["near", "eip155:1", "eip155:42161", "eip155:8453"],
      allowed_venues: ["near_intents_1click"],
      max_gas_budget: "0",
    },
  };
}

/**
 * Produce an approval request artifact. Does not deploy.
 */
export function buildDeploymentApprovalRequest({
  targetAccount,
  wasmPath = DEFAULT_WASM,
  initArgs,
  maxNear,
  purpose = "NIO mainnet policy contract deploy (hackathon MVP)",
}) {
  assertNetworkIsolation(MAINNET, { allowMainnet: true });
  if (!targetAccount?.endsWith(".near")) {
    throw new Error("target_must_be_mainnet_account");
  }
  if (targetAccount.startsWith(MAINNET.demoPrefix)) {
    throw new Error("demo_target_banned");
  }
  if (!existsSync(wasmPath)) {
    throw new Error(`wasm_missing:${wasmPath} — run cargo build --release --target wasm32-unknown-unknown`);
  }
  const artifact = sha256File(wasmPath);
  const init = initArgs || null;
  return {
    status: "AWAITING_OPERATOR_APPROVAL",
    network: "mainnet",
    target_account: targetAccount,
    wasm: artifact,
    mpc_signer: MAINNET.mpc.signer,
    init_args: init,
    max_near: String(maxNear || STORAGE_HINT.recommended_max_near_request),
    storage_hint: STORAGE_HINT,
    purpose,
    deploy_command: [
      "node scripts/mainnet/deploy-policy.mjs \\",
      `  --account ${targetAccount} \\`,
      `  --wasm ${wasmPath} \\`,
      `  --sha256 ${artifact.sha256} \\`,
      `  --max-near ${maxNear || STORAGE_HINT.recommended_max_near_request} \\`,
      "  --approve-file docs/approvals/MAINNET_DEPLOY_APPROVAL.json",
    ].join("\n"),
    required_approval_fields: [
      "target_account",
      "wasm_sha256",
      "max_near",
      "owner_account",
      "agent_account",
      "portfolio_id",
      "approver",
      "approved_at",
    ],
    note: "Do NOT run deploy until approval JSON matches this artifact hash and max NEAR",
  };
}

export async function verifyDeployedPolicy(accountId, opts = {}) {
  assertNetworkIsolation(MAINNET, { allowMainnet: true });
  const rpc = opts.rpc || (await pickRpc(MAINNET.near.rpcs));
  const acct = await viewAccount(rpc, accountId);
  const views = {};
  for (const m of [
    "get_owner",
    "get_agent",
    "get_mpc_signer",
    "get_derivation_path",
    "get_mandate_epoch",
    "get_revocation_status",
  ]) {
    try {
      views[m] = await viewFunction(rpc, accountId, m, {});
    } catch (e) {
      views[m] = { error: String(e.message || e) };
    }
  }
  const mpcOk = views.get_mpc_signer === MAINNET.mpc.signer;
  return {
    network: "mainnet",
    account_id: accountId,
    rpc,
    account: acct,
    views,
    mpc_signer_ok: mpcOk,
    explorer: MAINNET.near.explorerAccount(accountId),
    status:
      acct && mpcOk && !views.get_owner?.error
        ? "VERIFIED_ON_MAINNET"
        : "DEPLOYED_OR_PARTIAL_READ",
  };
}

export function writeApprovalStub(outPath, request) {
  mkdirSync(dirname(outPath), { recursive: true });
  const stub = {
    approved: false,
    target_account: request.target_account,
    wasm_sha256: request.wasm.sha256,
    wasm_bytes: request.wasm.bytes,
    max_near: request.max_near,
    owner_account: request.init_args?.owner || null,
    agent_account: request.init_args?.agent || null,
    portfolio_id: request.init_args?.portfolio_id || null,
    mpc_signer: MAINNET.mpc.signer,
    approver: null,
    approved_at: null,
    purpose: request.purpose,
  };
  writeFileSync(outPath, JSON.stringify(stub, null, 2));
  return stub;
}
