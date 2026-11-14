#!/usr/bin/env node
/**
 * J13 READ-ONLY key isolation audit (mainnet).
 * Classifies Ledger vs software ops. Never mutates keys.
 */
import { writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MAINNET_IDENTITIES } from "../../packages/mainnet/identities.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const RPC_CANDIDATES = [
  process.env.NIO_MAINNET_RPC,
  "https://free.rpc.fastnear.com",
  "https://rpc.mainnet.fastnear.com",
  "https://1rpc.io/near",
  process.env.NEAR_RPC_URL,
  process.env.NEAR_RPC,
].filter(Boolean);

const LEDGER_PK = MAINNET_IDENTITIES.ledger_public_key;
const OPS_PK = MAINNET_IDENTITIES.ops_public_key;

let RPC = RPC_CANDIDATES[0];

async function viewAccessKeyList(account_id) {
  let lastErr;
  for (const url of RPC_CANDIDATES) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "j13-key-audit",
          method: "query",
          params: {
            request_type: "view_access_key_list",
            finality: "final",
            account_id,
          },
        }),
      });
      const json = await res.json();
      if (json.error) {
        lastErr = new Error(JSON.stringify(json.error));
        continue;
      }
      RPC = url;
      return json.result?.keys || [];
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("no_rpc");
}

function classify(pk) {
  if (pk === LEDGER_PK) return "LEDGER_ADMIN";
  if (pk === OPS_PK) return "SOFTWARE_OPS";
  return "UNKNOWN";
}

const accounts = [MAINNET_IDENTITIES.owner, MAINNET_IDENTITIES.agent, MAINNET_IDENTITIES.policy];
const byAccount = {};

for (const account_id of accounts) {
  const keys = await viewAccessKeyList(account_id);
  byAccount[account_id] = keys.map((k) => ({
    public_key: k.public_key,
    permission:
      k.access_key?.permission === "FullAccess" ? "FullAccess" : "FunctionCall",
    classification: classify(k.public_key),
    nonce: k.access_key?.nonce,
  }));
}

const ownerKeys = byAccount[MAINNET_IDENTITIES.owner].map((k) => k.public_key);
const agentKeys = byAccount[MAINNET_IDENTITIES.agent].map((k) => k.public_key);
const policyKeys = byAccount[MAINNET_IDENTITIES.policy].map((k) => k.public_key);

const softwareOnOwner = byAccount[MAINNET_IDENTITIES.owner].some(
  (k) => k.classification === "SOFTWARE_OPS"
);
const softwareOnPolicy = byAccount[MAINNET_IDENTITIES.policy].some(
  (k) => k.classification === "SOFTWARE_OPS"
);
const opsOnAgent = byAccount[MAINNET_IDENTITIES.agent].some(
  (k) => k.classification === "SOFTWARE_OPS" && k.permission === "FullAccess"
);
const ledgerShared = [MAINNET_IDENTITIES.owner, MAINNET_IDENTITIES.agent, MAINNET_IDENTITIES.policy].every(
  (a) => byAccount[a].some((k) => k.classification === "LEDGER_ADMIN")
);

const report = {
  kind: "J13_KEY_ISOLATION_AUDIT",
  mode: "READ_ONLY",
  audited_at: new Date().toISOString(),
  rpc: RPC,
  classifications: {
    ledger_public_key: LEDGER_PK,
    ops_public_key: OPS_PK,
  },
  accounts: byAccount,
  assertions: {
    software_ops_only_on_agent: !softwareOnOwner && !softwareOnPolicy && opsOnAgent,
    ops_on_agent: opsOnAgent,
    software_absent_from_owner: !softwareOnOwner,
    software_absent_from_policy: !softwareOnPolicy,
    ledger_fa_on_owner_agent_policy: ledgerShared,
    agent_can_operate_without_owner_software_cred: opsOnAgent && !softwareOnOwner,
  },
  findings: [],
  mutations: false,
};

if (softwareOnOwner || softwareOnPolicy) {
  report.findings.push({
    severity: "CRITICAL",
    code: "SOFTWARE_OPS_ON_OWNER_OR_POLICY",
  });
}
if (!opsOnAgent) {
  report.findings.push({
    severity: "HIGH",
    code: "MISSING_AGENT_OPS_KEY",
  });
}
if (ledgerShared) {
  report.findings.push({
    severity: "INFO",
    code: "SHARED_LEDGER_FA_RECOVERY_BY_DESIGN",
    note: "Ledger pubkey on all three is Option A recovery/admin — not software key export",
  });
}

const critical = report.findings.some((f) => f.severity === "CRITICAL");
report.verdict = critical
  ? "FAIL"
  : opsOnAgent && !softwareOnOwner && !softwareOnPolicy
    ? "PASS_SOFTWARE_ISOLATED"
    : "FAIL";

const out = join(ROOT, "docs", "evidence", "J13_KEY_ISOLATION_AUDIT.json");
await writeFile(out, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      verdict: report.verdict,
      assertions: report.assertions,
      findings: report.findings,
      evidence: out,
    },
    null,
    2
  )
);
process.exit(critical ? 1 : 0);
