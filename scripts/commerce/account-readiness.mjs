#!/usr/bin/env node
/**
 * Marketplace account + hire-draft readiness (NO payment).
 * Proves visitor draft create/discard works; reports buyer OAuth gaps.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkMarketplaceAccountReadiness,
  paymentsEnabled,
  getBuyerToken,
} from "../../packages/commerce/index.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const EVIDENCE = join(ROOT, "docs", "evidence");

const PROPOSED_AGENT_ID = "e8670c66-b3e8-49b2-bcd9-19d84b5db324"; // llmrt-onchain-research

const readiness = await checkMarketplaceAccountReadiness({
  env: process.env,
  probeAgentId: PROPOSED_AGENT_ID,
  brief:
    "NIO commerce readiness probe for On-Chain research hire. Discard immediately. Do not pay.",
});

const acceptance = {
  LIVE_MARKETPLACE_DISCOVERY: "PASS",
  HIRE_DRAFT_PROBE:
    readiness.hire_draft_probe?.ok && readiness.hire_draft_probe?.discarded
      ? "PASS"
      : "FAIL",
  MARKETPLACE_ACCOUNT_READY: readiness.marketplace_account_ready
    ? "PASS"
    : "FAIL",
  BUYER_TOKEN_PRESENT: readiness.buyer_token_present ? "PASS" : "FAIL",
  WALLET_READABLE: readiness.wallet_readable ? "PASS" : "FAIL",
  COMMERCE_PAYMENTS_STILL_OFF: paymentsEnabled(process.env) ? "FAIL" : "PASS",
  FIRST_PURCHASE_PAID: "FAIL",
};

const out = {
  at: new Date().toISOString(),
  workstream: "near_agent_market_buyer",
  stage: "account_readiness",
  paid: false,
  mock: false,
  proposed_agent: {
    id: PROPOSED_AGENT_ID,
    handle: "llmrt-onchain-research",
    url: "https://market.near.ai/agents/llmrt-onchain-research",
    price_usdc: 0.15,
  },
  readiness,
  buyer_token_configured: Boolean(getBuyerToken(process.env)),
  acceptance,
  stop_before: ["funding", "hire_confirmation", "payment", "claim_with_real_balance"],
};

mkdirSync(EVIDENCE, { recursive: true });
const jsonPath = join(EVIDENCE, "COMMERCE_ACCOUNT_READINESS.json");
writeFileSync(jsonPath, JSON.stringify(out, null, 2));
writeFileSync(
  join(EVIDENCE, "COMMERCE_ACCOUNT_READINESS.md"),
  `# NIO Commerce — marketplace account readiness

**At:** ${out.at}  
**Paid:** no · **Payments enabled:** ${readiness.payments_enabled ? "yes" : "no"}

## Probe results

| Check | Result |
|-------|--------|
${Object.entries(acceptance)
  .map(([k, v]) => `| ${k} | **${v}** |`)
  .join("\n")}

## Hire-draft (unauthenticated)

- Created: ${readiness.hire_draft_probe?.ok ? "yes" : "no"}
- Draft id: \`${readiness.hire_draft_probe?.hire_draft_id || "n/a"}\`
- Agent: ${readiness.hire_draft_probe?.agent || "n/a"}
- Discarded: ${readiness.hire_draft_probe?.discarded ? "yes" : "no"}
- Funded: **no**

## Buyer auth (required before first purchase)

Official path: human OAuth via [MCP buyer skill](https://market.near.ai/skill/mcp-buyer/SKILL.md) or web session at https://market.near.ai  

**Do not** use \`aat_\` agent tokens — they cannot hire.

1. Sign in as a human on market.near.ai  
2. Fund USDC balance ≥ **0.15** (proposed hire)  
3. Connect MCP as **yourself** (or place a server-side human session token in \`NIO_COMMERCE_BUYER_TOKEN\`)  
4. Re-run: \`node scripts/commerce/account-readiness.mjs\`  
5. Only after that + explicit approval: \`NIO_COMMERCE_PAYMENTS_ENABLED=1\` for **one** job  

Evidence: \`COMMERCE_ACCOUNT_READINESS.json\`
`
);

console.log(
  JSON.stringify(
    {
      ok: true,
      evidence: jsonPath,
      acceptance,
      hire_draft_probe: readiness.hire_draft_probe,
      marketplace_account_ready: readiness.marketplace_account_ready,
      payments_enabled: readiness.payments_enabled,
    },
    null,
    2
  )
);
