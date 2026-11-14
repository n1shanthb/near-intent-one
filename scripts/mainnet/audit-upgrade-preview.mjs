#!/usr/bin/env node
/**
 * Preview owner Ledger upgrade for decision-audit WASM.
 * DOES NOT deploy. Stop for explicit owner authorization.
 *
 *   node scripts/mainnet/audit-upgrade-preview.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MAINNET_IDENTITIES } from "../../packages/mainnet/identities.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const EVIDENCE = join(ROOT, "docs", "evidence");
mkdirSync(EVIDENCE, { recursive: true });
const WASM = join(
  ROOT,
  "contracts/policy/target/wasm32-unknown-unknown/release/policy.wasm"
);

const report = {
  kind: "AUDIT_MAINNET_UPGRADE_STATUS",
  as_of: new Date().toISOString(),
  verdict: "PREVIEW_ONLY_STOP_BEFORE_DEPLOY",
  policy: MAINNET_IDENTITIES.policy,
  owner: MAINNET_IDENTITIES.owner,
  method_added: "record_decision_cycle",
  migrate_method: "migrate_state_v2_decision_audit",
  nep297: { standard: "nio_agent_audit", version: "1.0.0" },
  events: [
    "research_completed",
    "strategy_proposed",
    "fitter_evaluated",
    "critic_evaluated",
    "decision_finalized",
  ],
  layout: "additive side-storage dec:<cycle_id>; PolicyContract Borsh unchanged",
  current_live: {
    code_hash: "ARJJNXWAqrN1fD76rVAFictk1ioasfwSyQaiofWerMpc",
    state_version: 1,
    mandate_epoch: 3,
    note: "Live WASM lacks record_decision_cycle until this upgrade",
  },
  requires_owner_ledger: true,
  financial_guardrails:
    "No mandate widen, no unpause change required, audit works while paused; does not authorize trades",
  deploy_when_authorized: [
    "Rebuild policy.wasm",
    "Confirm new SHA256 in this file",
    "near contract deploy policy.nishanthb.near use-file <wasm> without-init-call … sign-with-ledger",
    "near … migrate_state_v2_decision_audit … sign-with-ledger",
    "Set NIO_DECISION_AUDIT_ON_CHAIN=1 and run autonomous-demo-cycle",
  ],
};

if (existsSync(WASM)) {
  const buf = readFileSync(WASM);
  report.local_wasm = {
    path: WASM,
    bytes: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex").toUpperCase(),
    note: "May be stale until cargo build --release after audit methods; rebuild before Ledger deploy",
  };
} else {
  report.local_wasm = { missing: true };
}

writeFileSync(
  join(EVIDENCE, "AUDIT_MAINNET_UPGRADE_STATUS.json"),
  JSON.stringify(report, null, 2)
);
console.log(JSON.stringify(report, null, 2));
