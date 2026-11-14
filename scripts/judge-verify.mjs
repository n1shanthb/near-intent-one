#!/usr/bin/env node
/**
 * Safe, read-only judge verification.
 * NEVER signs, spends, deploys, or mutates policy/mandate.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
const isWin = process.platform === "win32";

function run(name, command, opts = {}) {
  const r = spawnSync(command, {
    cwd: opts.cwd || ROOT,
    encoding: "utf8",
    shell: true,
    timeout: opts.timeout || 300_000,
    env: { ...process.env, ...opts.env },
  });
  const ok = r.status === 0;
  const tail = ((r.stderr || "") + "\n" + (r.stdout || "")).trim().slice(-500);
  results.push({
    name,
    ok,
    status: r.status,
    note: ok ? "PASS" : tail || `exit_${r.status}`,
  });
  console.error(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.error(tail.slice(0, 300));
  return ok;
}

async function checkHttp(name, url, pred) {
  try {
    const res = await fetch(url, { headers: { accept: "application/json,text/html" } });
    const text = await res.text();
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* html */
    }
    const ok = res.ok && (pred ? pred(body, res, text) : true);
    results.push({ name, ok, status: res.status, note: ok ? "PASS" : "unexpected_body" });
    console.error(`${ok ? "PASS" : "FAIL"}  ${name}`);
    return ok;
  } catch (e) {
    results.push({ name, ok: false, status: 0, note: String(e.message || e) });
    console.error(`FAIL  ${name}: ${e.message || e}`);
    return false;
  }
}

console.error("NIO judge:verify — read-only checks only\n");

run(
  "node_version",
  `"${process.execPath}" -e "const n=+process.versions.node.split('.')[0]; if(n<20) process.exit(1)"`
);

const pnpm = isWin ? "pnpm.cmd" : "pnpm";
run("frontend_build", `${pnpm} --filter web run build`, { timeout: 300_000 });
run("test_autonomous", `${pnpm} run test:autonomous`, { timeout: 180_000 });
run("test_mandate", `${pnpm} run test:mandate`, { timeout: 120_000 });

if (existsSync(join(ROOT, "contracts/policy/Cargo.toml"))) {
  run("policy_cargo_test", "cargo test --quiet", {
    cwd: join(ROOT, "contracts/policy"),
    timeout: 300_000,
  });
}

await checkHttp(
  "live_frontend",
  "https://near-intent-one.vercel.app/",
  (_b, _r, text) => typeof text === "string" && /html/i.test(text) && text.length > 50
);
await checkHttp(
  "live_inspect",
  "https://near-intent-one.vercel.app/inspect/nishanthb.near",
  (_b, _r, text) => typeof text === "string" && text.length > 100
);
await checkHttp("oci_mandate", "https://nio-api-hack26.duckdns.org/mainnet/mandate", (b) => {
  return (
    b &&
    b.ok === true &&
    Number(b.mandate_epoch) >= 3 &&
    b.autonomous_trading === true &&
    b.paused === false &&
    String(b.limits?.max_trade_value || "").length > 0
  );
});
await checkHttp(
  "vercel_mandate_bff",
  "https://near-intent-one.vercel.app/api/v1/mainnet/mandate",
  (b) => b && b.ok === true && Number(b.mandate_epoch) >= 3
);

const failed = results.filter((r) => !r.ok);
const report = {
  kind: "JUDGE_VERIFY",
  at: new Date().toISOString(),
  safe: true,
  note: "No signing, spending, deploy, or mandate mutation",
  results,
  verdict: failed.length === 0 ? "PASS" : "PARTIAL",
  failed: failed.map((f) => f.name),
};
console.log(JSON.stringify(report, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
