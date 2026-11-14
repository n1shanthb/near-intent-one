#!/usr/bin/env node
/**
 * Mainnet audit WASM upgrade (record_decision_cycle).
 * WITHOUT init. Owner Ledger required.
 *
 *   node scripts/mainnet/audit-deploy-upgrade.mjs --plan
 *   node scripts/mainnet/audit-deploy-upgrade.mjs --execute-deploy
 *   node scripts/mainnet/audit-deploy-upgrade.mjs --execute-migrate
 *   node scripts/mainnet/audit-deploy-upgrade.mjs --verify
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { MAINNET_IDENTITIES } from "../../packages/mainnet/identities.mjs";
import { LEDGER_HD, NEAR_CLI, WASM_PATH } from "./j18-deploy-upgrade.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const EVIDENCE = join(ROOT, "docs", "evidence");
mkdirSync(EVIDENCE, { recursive: true });

const RPCS = [
  process.env.NIO_MAINNET_RPC,
  "https://rpc.mainnet.fastnear.com",
  "https://rpc.mainnet.near.org",
].filter(Boolean);

async function pickRpc() {
  for (const u of RPCS) {
    try {
      const j = await (
        await fetch(u, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: [] }),
        })
      ).json();
      if (!j.error) return u;
    } catch {
      /* next */
    }
  }
  throw new Error("no_mainnet_rpc");
}

async function rpc(url, method, params) {
  return (
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    })
  ).json();
}

async function viewAccount(url) {
  const j = await rpc(url, "query", {
    request_type: "view_account",
    finality: "final",
    account_id: MAINNET_IDENTITIES.policy,
  });
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}

async function viewFn(url, methodName, args = {}) {
  const j = await rpc(url, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: MAINNET_IDENTITIES.policy,
    method_name: methodName,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (j.error || j.result?.error) return { error: j.error || j.result.error };
  const raw = Buffer.from(j.result.result).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function sha256Wasm() {
  const buf = readFileSync(WASM_PATH);
  return {
    path: WASM_PATH,
    bytes: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex").toUpperCase(),
  };
}

function runNear(args) {
  if (!existsSync(NEAR_CLI)) return { ok: false, error: `near_cli_missing:${NEAR_CLI}` };
  const r = spawnSync(NEAR_CLI, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 600_000,
    windowsHide: false,
  });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: (r.stdout || "").slice(-10000),
    stderr: (r.stderr || "").slice(-10000),
  };
}

function extractTx(text) {
  const m = text.match(/Transaction ID:\s*([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

async function snapshot(url) {
  const acct = await viewAccount(url);
  return {
    code_hash: acct.code_hash,
    storage_usage: acct.storage_usage,
    amount_yocto: acct.amount,
    owner: await viewFn(url, "get_owner"),
    agent: await viewFn(url, "get_agent"),
    portfolio: await viewFn(url, "get_portfolio_id"),
    paused: await viewFn(url, "get_paused"),
    epoch: await viewFn(url, "get_mandate_epoch"),
    autonomous: await viewFn(url, "get_autonomous_trading"),
    enforce: await viewFn(url, "get_enforce_autonomous_on_agent"),
    state_version: await viewFn(url, "get_state_version"),
    decision_probe: await viewFn(url, "get_decision_cycle", {
      cycle_id: "probe-missing",
    }),
  };
}

async function main() {
  const planOnly = process.argv.includes("--plan");
  const execDeploy = process.argv.includes("--execute-deploy");
  const execMigrate = process.argv.includes("--execute-migrate");
  const verify = process.argv.includes("--verify") || planOnly || execDeploy || execMigrate;

  const wasm = sha256Wasm();
  const url = await pickRpc();
  const pre = await snapshot(url);
  const report = {
    kind: "AUDIT_WASM_DEPLOY",
    started_at: new Date().toISOString(),
    policy: MAINNET_IDENTITIES.policy,
    owner: MAINNET_IDENTITIES.owner,
    ledger_hd: LEDGER_HD,
    without_init_call: true,
    wasm,
    prior_j14_sha: "8BF2AEAF72FDF7675630684209FD7EA8BEB9A61CE3021A3B4B795B6E39B12931",
    sha_changed_from_j14: wasm.sha256 !== "8BF2AEAF72FDF7675630684209FD7EA8BEB9A61CE3021A3B4B795B6E39B12931",
    pre,
    balance_near: (Number(pre.amount_yocto) / 1e24).toFixed(4),
  };

  if (!report.sha_changed_from_j14) {
    report.verdict = "NO_GO";
    report.blocker = "wasm_sha_unchanged_rebuild_required";
    writeFileSync(join(EVIDENCE, "AUDIT_WASM_DEPLOY_PLAN.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

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
    "migrate_state_v2_decision_audit",
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
    writeFileSync(join(EVIDENCE, "AUDIT_WASM_DEPLOY_PLAN.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (execDeploy) {
    console.error("LEDGER: confirm DeployContract (audit WASM, NO init)...");
    const dep = runNear(report.deploy_cmd);
    report.deploy = dep;
    report.deploy_tx = extractTx(`${dep.stdout}\n${dep.stderr}`);
    await new Promise((r) => setTimeout(r, 3000));
    report.post_deploy = await snapshot(url);
    report.code_hash_changed = report.pre.code_hash !== report.post_deploy.code_hash;
    report.preservation = {
      owner_ok: report.pre.owner === report.post_deploy.owner,
      agent_ok: report.pre.agent === report.post_deploy.agent,
      portfolio_ok: report.pre.portfolio === report.post_deploy.portfolio,
      epoch_ok: report.pre.epoch === report.post_deploy.epoch,
      paused_ok: report.pre.paused === report.post_deploy.paused,
    };
  }

  if (execMigrate) {
    console.error("LEDGER: confirm migrate_state_v2_decision_audit...");
    const mig = runNear(report.migrate_cmd);
    report.migrate = mig;
    report.migrate_tx = extractTx(`${mig.stdout}\n${mig.stderr}`);
    await new Promise((r) => setTimeout(r, 2500));
    report.post_migrate = await snapshot(url);
  }

  if (verify || execDeploy || execMigrate) {
    const cur = await snapshot(url);
    report.verify = {
      code_hash: cur.code_hash,
      state_version: cur.state_version,
      record_method_present: !cur.decision_probe?.error?.toString?.().includes?.("MethodNotFound")
        && !(typeof cur.decision_probe?.error === "object" && JSON.stringify(cur.decision_probe.error).includes("MethodNotFound")),
      decision_probe: cur.decision_probe,
      paused: cur.paused,
      epoch: cur.epoch,
      autonomous: cur.autonomous,
      enforce: cur.enforce,
    };
    // get_decision_cycle returns null for missing — MethodNotFound only if absent
    const errStr = JSON.stringify(cur.decision_probe?.error || "");
    report.verify.record_method_present = !errStr.includes("MethodNotFound");
  }

  report.finished_at = new Date().toISOString();
  writeFileSync(join(EVIDENCE, "AUDIT_WASM_DEPLOY_RESULT.json"), JSON.stringify(report, null, 2));
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
