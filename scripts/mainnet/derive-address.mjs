#!/usr/bin/env node
/**
 * Mainnet ECDSA address derivation via v1.signer (read-only).
 * Usage:
 *   node scripts/mainnet/derive-address.mjs --policy nio-policy.near --portfolio hack26-canary
 */
import { deriveMainnetEvmAddress } from "../../packages/mainnet/mpc.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return def;
}

const policy = arg("policy", process.env.NIO_MAINNET_POLICY_ACCOUNT);
const portfolio = arg("portfolio", process.env.NIO_MAINNET_PORTFOLIO_ID || "hack26-canary");

if (!policy) {
  console.error("required: --policy <account.near>");
  process.exit(1);
}

const out = await deriveMainnetEvmAddress({
  policyContract: policy,
  portfolioId: portfolio,
});
console.log(JSON.stringify(out, null, 2));
