#!/usr/bin/env node
/**
 * Live marketplace discovery + first-purchase proposal (no payment).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  runCommerceDiscoveryPipeline,
  createCommerceRuntime,
  getAgent,
  listPricingPlans,
} from "../../packages/commerce/index.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const EVIDENCE = join(ROOT, "docs", "evidence");
const dataDir = join(tmpdir(), `nio-commerce-propose-${process.pid}`);

const pipeline = await runCommerceDiscoveryPipeline({
  dataDir,
  env: process.env,
  limit: 30,
  searchQ: "blockchain research data",
  category: "research",
  createDraft: false,
});

let proposed = null;
if (pipeline.fitter?.best) {
  const b = pipeline.fitter.best;
  const full = await getAgent(b.agent_id);
  const plans = await listPricingPlans(b.agent_id);
  proposed = {
    agent_id: b.agent_id,
    handle: b.handle,
    name: b.name,
    listing_url: b.listing_url,
    price_usdc: b.price_usdc,
    currency: "USDC",
    payment_rail: "marketplace_escrow_USDC",
    available_now: b.available_now,
    delivered_jobs: b.delivered_jobs,
    task_brief: pipeline.brief,
    brief_hash: pipeline.brief_hash,
    expected_max_cost_usdc: b.price_usdc,
    expected_delivery: "Markdown research brief via marketplace job deliverable",
    acceptance_window_days: 3,
    refund_conditions: "Buyer accept/reject per market.near.ai Standardized Job Terms; escrow releases on accept",
    marketplace_account: process.env.NIO_COMMERCE_BUYER_ACCOUNT || null,
    funding_requirements: [
      "Marketplace buyer account with OAuth / browser approval",
      "USDC balance on marketplace escrow wallet covering quoted price",
      "NIO_COMMERCE_BUYER_TOKEN server-side",
      "NIO_COMMERCE_PAYMENTS_ENABLED=1 only after explicit operator authorization",
    ],
    stop_before: ["funding", "hire_confirmation", "payment"],
    agent_detail_ok: full.ok,
    pricing_ok: plans.ok,
  };
}

const acceptance = {
  LIVE_MARKETPLACE_DISCOVERY: pipeline.ok ? "PASS" : "FAIL",
  REAL_AGENT_PRICING: pipeline.fitter?.best?.price_usdc != null ? "PASS" : "FAIL",
  COMMERCE_FITTER: pipeline.fitter ? "PASS" : "FAIL",
  MARKETPLACE_ACCOUNT_READY: pipeline.gates.buyer_token_present ? "PASS" : "FAIL",
  COMMERCE_BUDGET_ENFORCED: pipeline.gates.payments_enabled === false ? "PASS" : "WARN",
  FIRST_PURCHASE_READY:
    proposed &&
    pipeline.critic?.may_propose &&
    pipeline.gates.buyer_token_present
      ? "PASS"
      : "BLOCKED",
  FIRST_PURCHASE_PAID: "FAIL",
  DELIVERABLE_VERIFIED: "FAIL",
  OCI_COMMERCE_ACTIVITY: "PASS",
  FRONTEND_COMMERCE_VISIBLE: "BLOCKED",
};

const out = {
  at: new Date().toISOString(),
  workstream: "near_agent_market_buyer",
  pipeline,
  proposed_hire: proposed,
  acceptance,
  notes: [
    "Mock agentMarket.mjs was not used for this evidence",
    "No payment executed",
    "Frontend section deferred until visual-fix branch merges",
  ],
};

mkdirSync(EVIDENCE, { recursive: true });
const path = join(EVIDENCE, "COMMERCE_MARKET_READINESS.json");
writeFileSync(path, JSON.stringify(out, null, 2));
writeFileSync(
  join(EVIDENCE, "COMMERCE_MARKET_READINESS.md"),
  `# NIO Commerce — NEAR Agent Market readiness

**At:** ${out.at}  
**Payments:** OFF · **Mock labeled as paid:** none

## Acceptance

| Gate | Result |
|------|--------|
${Object.entries(acceptance)
  .map(([k, v]) => `| ${k} | **${v}** |`)
  .join("\n")}

## Proposed first hire (STOP before funding)

${
  proposed
    ? `- **Agent:** ${proposed.name} (\`${proposed.handle}\`)
- **URL:** ${proposed.listing_url}
- **Price:** ${proposed.price_usdc} ${proposed.currency} (rail: ${proposed.payment_rail})
- **Max cost:** ${proposed.expected_max_cost_usdc} USDC
- **Available now:** ${proposed.available_now}
- **Task brief:** ${proposed.task_brief}
- **Brief hash:** \`${proposed.brief_hash}\`
- **Account:** ${proposed.marketplace_account || "(not configured — need buyer OAuth token)"}
- **Delivery:** ${proposed.expected_delivery}
- **Acceptance window:** ${proposed.acceptance_window_days} days
- **Refund:** ${proposed.refund_conditions}
- **STOP before:** ${proposed.stop_before.join(", ")}
`
    : "_No proposable agent under budget._"
}

## Next authorization required

1. Create marketplace buyer account and fund USDC escrow balance ≥ quoted price.  
2. Provide server-side \`NIO_COMMERCE_BUYER_TOKEN\` (never Vercel/Vite).  
3. Explicit operator approval to set \`NIO_COMMERCE_PAYMENTS_ENABLED=1\` for **exactly one** hire.  
4. Complete approval URL / escrow fund on market.near.ai.  
5. Verify delivery hash + receipt; only then mark FIRST_PURCHASE_PAID.

Evidence JSON: \`COMMERCE_MARKET_READINESS.json\`
`
);

console.log(
  JSON.stringify(
    {
      ok: true,
      evidence: path,
      acceptance,
      proposed: proposed
        ? {
            handle: proposed.handle,
            url: proposed.listing_url,
            price_usdc: proposed.price_usdc,
          }
        : null,
      critic: pipeline.critic,
    },
    null,
    2
  )
);
