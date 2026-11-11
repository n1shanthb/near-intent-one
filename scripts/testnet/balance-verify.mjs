#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { diagnosePortfolioA } from "../../packages/testnet/balanceDiagnostic.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = join(ROOT, "docs/evidence");
mkdirSync(outDir, { recursive: true });
const report = await diagnosePortfolioA();
const dest = join(outDir, "TESTNET_BALANCE_VERIFICATION.json");
writeFileSync(dest, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.error("wrote", dest);
