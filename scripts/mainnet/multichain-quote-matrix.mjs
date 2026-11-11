#!/usr/bin/env node
/**
 * Live four-chain 1Click dry-quote matrix + AI route selection.
 * Never sets dry:false. Never broadcasts.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runFourChainQuoteMatrix } from "../../packages/mainnet/multichainRouter.mjs";
import { prepareFundedCanaryApproval } from "../../packages/mainnet/canaryPrep.mjs";
import { fetchFourChainCatalog } from "../../packages/mainnet/tokenCatalog.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const amount = process.argv.includes("--amount")
  ? process.argv[process.argv.indexOf("--amount") + 1]
  : "1000000";

const catalog = await fetchFourChainCatalog();
const matrix = await runFourChainQuoteMatrix({
  catalog,
  amount,
  balances: {}, // no fictional balances — expect NO_TRADE for funded eligibility
  mandate: { paused: true, revoked: false, max_slippage_bps: 50 },
});

const canary = prepareFundedCanaryApproval({
  proposal: matrix.proposal,
  matrix,
  journalWritable: false,
  policyDeployed: false,
  policyPaused: true,
  ledgerOwned: false,
  testnetLifecycleOk: false,
  ownerDestination: process.env.NIO_MAINNET_RECIPIENT || null,
  ownerRefund: process.env.NIO_MAINNET_REFUND || null,
  verifiedBalances: {},
});

const out = {
  fetched_at: new Date().toISOString(),
  catalog: catalog.ok
    ? { counts: catalog.counts, api: catalog.api }
    : { ok: false, reason: catalog.reason },
  matrix,
  canary,
  safety: {
    dry: true,
    funded_sign: "OFF",
    broadcast: "OFF",
    acceptance_override: "FORBIDDEN",
  },
};

const dest = join(ROOT, "docs/MAINNET_MULTICHAIN_QUOTE_MATRIX.json");
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.error(`\nWrote ${dest}`);
if (!matrix.ok) process.exitCode = 2;
