#!/usr/bin/env node
/**
 * Sync local decision-audit JSON → OCI public store (read by /mainnet/decisions).
 * Usage: node scripts/mainnet/sync-decision-audit-to-oci.mjs
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const key = join(ROOT, ".gate-i-data", "oci-ssh", "nio-gate-i-api");
const host = process.env.NIO_OCI_SSH || "opc@129.225.72.169";
const local = process.env.NIO_DECISION_AUDIT_DIR || join(homedir(), ".nio-secure", "mainnet-decision-audit");
const remote = "/home/opc/.nio-secure/mainnet-decision-audit/";

const files = (await readdir(local)).filter(
  (f) => f.endsWith(".json") && !f.endsWith(".pending.json")
);
for (const f of files) {
  const r = spawnSync(
    "scp",
    ["-i", key, "-o", "StrictHostKeyChecking=accept-new", join(local, f), `${host}:${remote}${f}`],
    { encoding: "utf8" }
  );
  if (r.status !== 0) {
    console.error(JSON.stringify({ file: f, ok: false, err: (r.stderr || "").slice(-200) }));
  } else {
    console.log(JSON.stringify({ file: f, ok: true }));
  }
}
