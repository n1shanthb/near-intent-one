#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const target =
  process.argv[2] ||
  "/home/opc/near-intent-one/packages/services/api-server.mjs";
let src = readFileSync(target, "utf8");

if (src.includes('path === "/mainnet/balances") return json')) {
  console.log(JSON.stringify({ ok: true, already: true }));
  process.exit(0);
}

const needle =
  'if (path === "/mainnet/transactions") return json(req, res, 200, await listTransactions());';
const insert =
  needle +
  '\n      if (path === "/mainnet/balances") return json(req, res, 200, await getLiveBalancesSnapshot());';

if (!src.includes(needle)) {
  console.error(JSON.stringify({ ok: false, reason: "needle_missing" }));
  process.exit(1);
}

if (!src.includes("getLiveBalancesSnapshot")) {
  src = src.replace(
    "getLiveMandateSnapshot,",
    "getLiveMandateSnapshot,\n  getLiveBalancesSnapshot,"
  );
}

if (!src.includes('path === "/mainnet/balances" ||')) {
  src = src.replace(
    'path === "/mainnet/transactions" ||',
    'path === "/mainnet/transactions" ||\n      path === "/mainnet/balances" ||'
  );
}

src = src.replace(needle, insert);
writeFileSync(target, src);
console.log(JSON.stringify({ ok: true, patched: true, bytes: src.length }));
