#!/usr/bin/env node
/**
 * READ-ONLY audit of owner / agent / policy access keys on mainnet.
 * Does NOT add, rotate, or delete keys.
 */
import { writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const RPC = process.env.NEAR_RPC_URL || "https://rpc.mainnet.near.org";

const ACCOUNTS = [
  "nishanthb.near",
  "agent.nishanthb.near",
  "policy.nishanthb.near",
];

async function viewAccessKeyList(account_id) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "j12-key-audit",
      method: "query",
      params: {
        request_type: "view_access_key_list",
        finality: "final",
        account_id,
      },
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result?.keys || [];
}

function summarizeKeys(keys) {
  return keys.map((k) => ({
    public_key: k.public_key,
    permission:
      k.access_key?.permission === "FullAccess"
        ? "FullAccess"
        : typeof k.access_key?.permission === "object"
          ? "FunctionCall"
          : String(k.access_key?.permission),
    nonce: k.access_key?.nonce,
  }));
}

const byAccount = {};
for (const account_id of ACCOUNTS) {
  try {
    const keys = await viewAccessKeyList(account_id);
    byAccount[account_id] = {
      ok: true,
      keys: summarizeKeys(keys),
      full_access: summarizeKeys(keys).filter((k) => k.permission === "FullAccess"),
    };
  } catch (err) {
    byAccount[account_id] = { ok: false, error: String(err.message || err) };
  }
}

// Detect shared FullAccess public keys across owner and agent
const ownerFa = new Set(
  (byAccount["nishanthb.near"]?.full_access || []).map((k) => k.public_key)
);
const agentFa = new Set(
  (byAccount["agent.nishanthb.near"]?.full_access || []).map((k) => k.public_key)
);
const policyFa = new Set(
  (byAccount["policy.nishanthb.near"]?.full_access || []).map((k) => k.public_key)
);

const shared_owner_agent = [...ownerFa].filter((pk) => agentFa.has(pk));
const shared_owner_policy = [...ownerFa].filter((pk) => policyFa.has(pk));
const shared_agent_policy = [...agentFa].filter((pk) => policyFa.has(pk));

const report = {
  kind: "J12_AGENT_KEY_SECURITY",
  mode: "READ_ONLY",
  rpc: RPC,
  audited_at: new Date().toISOString(),
  accounts: byAccount,
  shared_full_access: {
    owner_agent: shared_owner_agent,
    owner_policy: shared_owner_policy,
    agent_policy: shared_agent_policy,
  },
  findings: [],
  mutations: false,
};

if (shared_owner_agent.length) {
  report.findings.push({
    severity: "CRITICAL",
    code: "SHARED_FULLACCESS_OWNER_AGENT",
    keys: shared_owner_agent,
  });
}
if (shared_agent_policy.length) {
  report.findings.push({
    severity: "HIGH",
    code: "SHARED_FULLACCESS_AGENT_POLICY",
    keys: shared_agent_policy,
  });
}
if (!byAccount["agent.nishanthb.near"]?.ok) {
  report.findings.push({
    severity: "WARN",
    code: "AGENT_ACCOUNT_UNREADABLE",
  });
}

const critical = report.findings.some((f) => f.severity === "CRITICAL");
report.verdict = critical ? "FAIL" : "PASS_WITH_REVIEW";
if (!report.findings.length) report.verdict = "PASS";

const out = join(ROOT, "docs", "evidence", "J12_AGENT_KEY_SECURITY.json");
await writeFile(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  verdict: report.verdict,
  shared_full_access: report.shared_full_access,
  findings: report.findings,
  key_counts: Object.fromEntries(
    Object.entries(byAccount).map(([a, v]) => [
      a,
      { total: v.keys?.length ?? null, full_access: v.full_access?.length ?? null, ok: v.ok },
    ])
  ),
  evidence: out,
}, null, 2));

process.exit(critical ? 1 : 0);
