#!/usr/bin/env node
/**
 * Mission 1 dry preflight — Ethereum USDC → NEAR NEP-141 USDC.
 * Read-only + dry quote only. No funded mutations.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runMission1EthNearPreflight } from "../../packages/mainnet/mission1EthNear.mjs";

const report = await runMission1EthNearPreflight();
const outDir = join("docs", "evidence");
mkdirSync(outDir, { recursive: true });
const jsonPath = join(outDir, "MAINNET_CHECKPOINT_J9_M1_DRY.json");
writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n");

const md = `# Checkpoint J9-M1-DRY — Ethereum → NEAR USDC canary preflight

**Mutations invoked:** false  
**Verdict:** **${report.verdict}**

## Proposed route (not authorized)

| Field | Value |
|-------|--------|
| Route | \`${report.route.id}\` |
| Amount | ${report.route.amount_label} (\`${report.route.amount}\`) |
| Source | Ethereum chain_id **1**, USDC \`${report.route.source_token}\` |
| Destination | NEAR **NEP-141 USDC** \`${report.route.asset_out}\` |
| Signer (MPC) | \`${report.route.signer_mpc}\` |
| Recipient | \`${report.route.recipient}\` |
| Refund | \`${report.route.refund_to}\` on Ethereum |
| Quote slippage | ${report.route.quote_slippage_bps} bps (policy max ${report.policy.max_slippage_bps}) |
| Min out (dry) | \`${report.quote.min_amount_out}\` |
| Est. source fee | ~${report.ethereum.economics.fee_eth?.toFixed?.(6) ?? "?"} ETH (≈$${report.ethereum.economics.fee_usd_approx?.toFixed?.(2) ?? "?"}) |

Destination is **not** \`wrap.near\`, native NEAR, or an intents balance id.

## Live checks

- 1Click tokens: eth_usdc=${report.tokens.eth_usdc}, near_usdc=${report.tokens.near_usdc}
- Policy paused=${report.policy.paused}, epoch=${report.policy.mandate_epoch}, eip155:1=${report.policy.chain_ok}
- MPC ETH wei=${report.ethereum.native_wei}, USDC raw=${report.ethereum.usdc_raw}, nonce=${report.ethereum.nonce_latest}/${report.ethereum.nonce_pending}
- NEAR USDC storage registered=${report.near_destination.storage?.registered}
- Dry quote policy fit=${report.quote.policy_fit?.result}

## Blockers

${(report.blockers || []).map((b) => `- ${b}`).join("\n") || "- (none)"}

## Warnings

${(report.warnings || []).map((w) => `- ${w}`).join("\n") || "- (none)"}

## Approval boundary

Stopped before any funded mutation. Explicit owner approval required for funding, storage registration, new operation auth, unpause window, propose/sign/broadcast, and reconcile.
`;
writeFileSync(join(outDir, "MAINNET_CHECKPOINT_J9_M1_DRY.md"), md);
console.log(JSON.stringify({ verdict: report.verdict, blockers: report.blockers, jsonPath }, null, 2));
process.exitCode = report.ok ? 0 : 2;
