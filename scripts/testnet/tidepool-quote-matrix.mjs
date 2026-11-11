#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { diagnosePortfolioA } from "../../packages/testnet/balanceDiagnostic.mjs";
import {
  fetchTidepoolTokens,
  runTidepoolQuoteMatrix,
  TIDEPOOL_EVM,
  TIDEPOOL_WNEAR,
} from "../../packages/testnet/tidepoolMultichain.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = join(ROOT, "docs/evidence");
mkdirSync(outDir, { recursive: true });

const diag = await diagnosePortfolioA();
const tokens = await fetchTidepoolTokens();
const mpc = diag.mpc_evm;
const balances = {};
const ethRow = diag.rows.find((r) => r.network === "ethereum_sepolia");
if (ethRow?.status === "VERIFIED_POSITIVE" || ethRow?.status === "GAS_UNFUNDED") {
  balances[TIDEPOOL_EVM.eth.origin_asset] = {
    amount_raw: ethRow.raw_token_balance,
    verified: ethRow.status === "VERIFIED_POSITIVE",
    chain: "ethereum_sepolia",
  };
}
const arbRow = diag.rows.find((r) => r.network === "arbitrum_sepolia");
if (arbRow?.raw_token_balance) {
  balances[TIDEPOOL_EVM.arb.origin_asset] = {
    amount_raw: arbRow.raw_token_balance,
    verified: arbRow.status === "VERIFIED_POSITIVE",
    chain: "arbitrum_sepolia",
  };
}
const baseRow = diag.rows.find((r) => r.network === "base_sepolia");
if (baseRow?.raw_token_balance) {
  balances[TIDEPOOL_EVM.base.origin_asset] = {
    amount_raw: baseRow.raw_token_balance,
    verified: baseRow.status === "VERIFIED_POSITIVE",
    chain: "base_sepolia",
  };
}

const matrix = await runTidepoolQuoteMatrix({
  refundTo: mpc,
  recipient: diag.policy_account,
  amount: "1000000",
  dry: true,
  balances,
});

const out = {
  fetched_at: new Date().toISOString(),
  destination: TIDEPOOL_WNEAR,
  tokens: tokens.ok ? { count: tokens.count, trust: tokens.trust } : tokens,
  balances_used: balances,
  matrix,
};
const dest = join(outDir, "TESTNET_TIDEPOOL_QUOTE_MATRIX.json");
writeFileSync(dest, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.error("wrote", dest);
