#!/usr/bin/env node
/**
 * Mainnet policy WASM upgrade to J14 autonomy bytecode.
 * Uses near-cli-rs + Ledger FullAccess on policy.nishanthb.near.
 * WITHOUT init call — preserves Borsh state.
 *
 * Usage:
 *   node scripts/mainnet/j18-deploy-upgrade.mjs --plan
 *   node scripts/mainnet/j18-deploy-upgrade.mjs --execute-deploy
 *   node scripts/mainnet/j18-deploy-upgrade.mjs --execute-migrate
 *   node scripts/mainnet/j18-deploy-upgrade.mjs --verify
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { MAINNET_IDENTITIES } from "../../packages/mainnet/identities.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const EVIDENCE = join(ROOT, "docs", "evidence");
mkdirSync(EVIDENCE, { recursive: true });

export const EXPECTED_WASM_SHA256 =
  "8BF2AEAF72FDF7675630684209FD7EA8BEB9A61CE3021A3B4B795B6E39B12931";
export const WASM_PATH = join(
  ROOT,
  "contracts/policy/target/wasm32-unknown-unknown/release/policy.wasm"
);
export const LEDGER_HD = "m/44'/397'/0'/0'/1'";
export const NEAR_CLI =
  process.env.NIO_NEAR_CLI ||
  join(
    homedir(),
    "bin",
    "near-cli-rs",
    "near-cli-rs-x86_64-pc-windows-msvc",
    "near.exe"
  );

const RPCS = [
  process.env.NIO_MAINNET_RPC,
  "https://rpc.mainnet.fastnear.com",
  "https://rpc.mainnet.near.org",
].filter(Boolean);

async function pickRpc() {
  for (const u of RPCS) {
    try {
      const res = await fetch(u, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: [] }),
      });
      const j = await res.json();
      if (!j.error) return u;
    } catch {
      /* next */
    }
  }
  throw new Error("no_mainnet_rpc");
}

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

async function viewAccount(url, accountId) {
  const j = await rpc(url, "query", {
    request_type: "view_account",
    finality: "final",
    account_id: accountId,
  });
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}

async function viewFn(url, accountId, methodName, args = {}) {
  const j = await rpc(url, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: accountId,
    method_name: methodName,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (j.error) return { error: j.error };
  if (j.result?.error) return { error: j.result.error };
  const raw = Buffer.from(j.result.result).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function sha256Wasm(path = WASM_PATH) {
  const buf = readFileSync(path);
  return {
    path,
    bytes: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex").toUpperCase(),
  };
}

export async function snapshotPolicy(url) {
  const policy = MAINNET_IDENTITIES.policy;
  const acct = await viewAccount(url, policy);
  const methods = [
    "get_paused",
    "get_mandate_epoch",
    "get_owner",
    "get_agent",
    "get_portfolio_id",
    "get_derivation_path",
    "get_intents_signer_id",
    "get_autonomous_trading",
    "get_enforce_autonomous_on_agent",
    "get_limits",
    "get_revocation_status",
    "get_reserved_pending_exposure",
    "get_state_version",
    "list_pending",
  ];
  const views = {};
  for (const m of methods) views[m] = await viewFn(url, policy, m);
  return {
    account_id: policy,
    amount_yocto: acct.amount,
    code_hash: acct.code_hash,
    storage_usage: acct.storage_usage,
    views,
  };
}

function criticalPreserved(pre, post) {
  const blockers = [];
  const cmp = (label, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) blockers.push(`${label}_changed`);
  };
  cmp("owner", pre.views.get_owner, post.views.get_owner);
  cmp("agent", pre.views.get_agent, post.views.get_agent);
  cmp("portfolio_id", pre.views.get_portfolio_id, post.views.get_portfolio_id);
  cmp("derivation_path", pre.views.get_derivation_path, post.views.get_derivation_path);
  cmp("intents_signer_id", pre.views.get_intents_signer_id, post.views.get_intents_signer_id);
  cmp("mandate_epoch", pre.views.get_mandate_epoch, post.views.get_mandate_epoch);
  cmp("paused", pre.views.get_paused, post.views.get_paused);
  cmp("limits", pre.views.get_limits, post.views.get_limits);
  cmp(
    "reserved_pending",
    pre.views.get_reserved_pending_exposure,
    post.views.get_reserved_pending_exposure
  );
  // pending list length / ids
  const preIds = (pre.views.list_pending || []).map((p) => p.operation_id).sort();
  const postIds = (post.views.list_pending || []).map((p) => p.operation_id).sort();
  if (JSON.stringify(preIds) !== JSON.stringify(postIds)) {
    blockers.push("pending_ids_changed");
  }
  return { ok: blockers.length === 0, blockers };
}

function runNear(args, { timeoutMs = 600_000 } = {}) {
  if (!existsSync(NEAR_CLI)) {
    return { ok: false, error: `near_cli_missing:${NEAR_CLI}` };
  }
  const r = spawnSync(NEAR_CLI, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: false,
  });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: (r.stdout || "").slice(-8000),
    stderr: (r.stderr || "").slice(-8000),
    error: r.error ? String(r.error) : null,
  };
}

async function main() {
  const planOnly = process.argv.includes("--plan");
  const execDeploy = process.argv.includes("--execute-deploy");
  const execMigrate = process.argv.includes("--execute-migrate");
  const verify = process.argv.includes("--verify") || planOnly || execDeploy || execMigrate;

  const wasm = sha256Wasm();
  const report = {
    kind: "MAINNET_WASM_DEPLOY_UPGRADE",
    started_at: new Date().toISOString(),
    policy: MAINNET_IDENTITIES.policy,
    owner: MAINNET_IDENTITIES.owner,
    ledger_hd: LEDGER_HD,
    ledger_pk_expected: MAINNET_IDENTITIES.ledger_public_key,
    wasm,
    expected_sha256: EXPECTED_WASM_SHA256,
    sha_match: wasm.sha256 === EXPECTED_WASM_SHA256,
    without_init_call: true,
  };

  if (!report.sha_match) {
    report.verdict = "NO_GO";
    report.blocker = "wasm_sha256_mismatch";
    writeFileSync(join(EVIDENCE, "MAINNET_WASM_DEPLOY_PLAN.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const url = await pickRpc();
  report.rpc = url;
  report.pre = await snapshotPolicy(url);
  report.pre_code_hash = report.pre.code_hash;
  report.balance_near = (Number(report.pre.amount_yocto) / 1e24).toFixed(4);
  report.storage_delta_bytes_est = Math.max(
    0,
    wasm.bytes - Number(report.pre.storage_usage || 0)
  );
  // Rough: 1e19 yocto per byte
  report.storage_cost_near_est = (
    (report.storage_delta_bytes_est * 1e19) /
    1e24
  ).toFixed(6);

  report.deploy_cmd = [
    "contract",
    "deploy",
    MAINNET_IDENTITIES.policy,
    "use-file",
    WASM_PATH,
    "without-init-call",
    "network-config",
    "mainnet",
    "sign-with-ledger",
    "--seed-phrase-hd-path",
    LEDGER_HD,
    "usb",
    "send",
  ];

  report.migrate_cmd = [
    "contract",
    "call-function",
    "as-transaction",
    MAINNET_IDENTITIES.policy,
    "migrate_state_v1_autonomy",
    "json-args",
    "{}",
    "prepaid-gas",
    "50.0 Tgas",
    "attached-deposit",
    "0 NEAR",
    "sign-as",
    MAINNET_IDENTITIES.owner,
    "network-config",
    "mainnet",
    "sign-with-ledger",
    "--seed-phrase-hd-path",
    LEDGER_HD,
    "usb",
    "send",
  ];

  if (planOnly || (!execDeploy && !execMigrate && !verify)) {
    report.verdict = "PLAN_READY";
    report.next = "Connect Ledger, unlock, open NEAR app → --execute-deploy → --execute-migrate → --verify";
    writeFileSync(join(EVIDENCE, "MAINNET_WASM_DEPLOY_PLAN.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (execDeploy) {
    console.error("LEDGER: confirm DeployContract on policy.nishanthb.near (NO init)...");
    const dep = runNear(report.deploy_cmd);
    report.deploy = dep;
    // Extract tx hash if present
    const m = `${dep.stdout}\n${dep.stderr}`.match(
      /([A-Za-z0-9]{40,88}).*(?:transaction|explorer|nearblocks)/i
    ) || `${dep.stdout}\n${dep.stderr}`.match(/\b([1-9A-HJ-NP-Za-km-z]{43,44})\b/);
    if (m) report.deploy_tx_guess = m[1];
    await new Promise((r) => setTimeout(r, 3000));
    report.post_deploy = await snapshotPolicy(url);
    report.preservation = criticalPreserved(report.pre, report.post_deploy);
    report.deployed_code_hash = report.post_deploy.code_hash;
    report.code_hash_changed =
      report.pre.code_hash !== report.post_deploy.code_hash;
  }

  if (execMigrate) {
    console.error("LEDGER: confirm migrate_state_v1_autonomy as nishanthb.near...");
    const mig = runNear(report.migrate_cmd);
    report.migrate = mig;
    await new Promise((r) => setTimeout(r, 2500));
    report.post_migrate = await snapshotPolicy(url);
    report.state_version = report.post_migrate.views.get_state_version;
  }

  if (verify || execDeploy || execMigrate) {
    const cur = await snapshotPolicy(url);
    report.verify = {
      code_hash: cur.code_hash,
      state_version: cur.views.get_state_version,
      enforce: cur.views.get_enforce_autonomous_on_agent,
      autonomous: cur.views.get_autonomous_trading,
      paused: cur.views.get_paused,
      owner: cur.views.get_owner,
      methods_present: {
        migrate: !cur.views.get_state_version?.error,
        enforce: !cur.views.get_enforce_autonomous_on_agent?.error,
      },
    };
  }

  report.finished_at = new Date().toISOString();
  const out = join(EVIDENCE, "MAINNET_WASM_DEPLOY_RESULT.json");
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
