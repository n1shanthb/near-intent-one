#!/usr/bin/env node
/**
 * J9 consolidated preflight — M1 Eth→NEAR, M2 Base→NEAR, funding, paper.
 * NO funding / Ledger / mutations.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runMission1EthNearPreflight } from "../../packages/mainnet/mission1EthNear.mjs";
import { runMission2BaseNearPreflight } from "../../packages/mainnet/mission2BaseNear.mjs";
import { runJ9RouteMatrix } from "../../packages/mainnet/j9RouteMatrix.mjs";
import { buildJ9FundingPlan } from "../../packages/mainnet/j9FundingPlan.mjs";
import {
  shadowQuoteRoute,
  createPaperState,
  recordPaperTrade,
  PAPER_DEFAULT_LIMITS,
  assertPaperFundedDisabled,
} from "../../packages/mainnet/paperTrading.mjs";
import {
  M1_ETH_NEAR_USDC,
  M2_BASE_NEAR_USDC,
} from "../../packages/mainnet/canaryRouteProfiles.mjs";
import { MAINNET_IDENTITIES } from "../../packages/mainnet/identities.mjs";

const outDir = join("docs", "evidence");
mkdirSync(outDir, { recursive: true });

console.error("[j9] Mission1 Eth→NEAR dry…");
const m1 = await runMission1EthNearPreflight();
m1.status = m1.ok ? "READY_FOR_OWNER_APPROVAL" : "AWAITING_FUNDING";
m1.preserved = true;

console.error("[j9] Mission2 Base→NEAR dry…");
const m2 = await runMission2BaseNearPreflight();

console.error("[j9] Route discovery matrix…");
const matrix = await runJ9RouteMatrix({ amount: "1000000", slip: 50 });

console.error("[j9] Consolidated funding plan…");
const funding = await buildJ9FundingPlan({ ethUsdHint: 3200 });
// Align M2 proposed amount with live policy-compliant search when available
if (m2.route?.amount) {
  funding.totals.m2_proposed_amount_usdc = Number(m2.route.amount) / 1e6;
  funding.totals.m2_strategy =
    m2.quote?.policy_fit?.result === "PASS"
      ? `reuse_base_usdc_${m2.route.amount}_policy_pass_awaiting_gas_storage`
      : funding.totals.m2_strategy;
  const row = funding.rows.find((r) => r.chain === "base" && r.asset === "USDC");
  if (row && m2.route.amount) {
    row.amount_needed_raw = m2.route.amount;
    row.amount_needed_ui = Number(m2.route.amount) / 1e6;
    row.for_canary = "Mission2 Base→NEAR USDC";
    if (m2.quote?.policy_fit?.result === "PASS") {
      row.top_up_raw = "0";
      row.top_up_ui = 0;
      row.buffer_note = `policy-compliant dry amount ${m2.route.amount} ≤ live balance; no USDC top-up`;
      row.source_of_funds = "reuse MPC Base USDC (J8B leftover, live-verified)";
    }
  }
}

console.error("[j9] Paper-trading shadow quotes…");
const paperGate = assertPaperFundedDisabled(process.env);
const paperState = createPaperState({
  ...PAPER_DEFAULT_LIMITS,
  min_net_edge_bps: -500,
});
const paperRoutes = [];
for (const r of [
  {
    routeId: M1_ETH_NEAR_USDC.id,
    assetIn: M1_ETH_NEAR_USDC.asset_in,
    assetOut: M1_ETH_NEAR_USDC.asset_out,
    recipient: M1_ETH_NEAR_USDC.recipient,
    refundTo: M1_ETH_NEAR_USDC.refund_to,
    gasUsd: m1.ethereum?.economics?.fee_usd_approx || 0.4,
    amount: "1000000",
  },
  {
    routeId: M2_BASE_NEAR_USDC.id,
    assetIn: M2_BASE_NEAR_USDC.asset_in,
    assetOut: M2_BASE_NEAR_USDC.asset_out,
    recipient: M2_BASE_NEAR_USDC.recipient,
    refundTo: M2_BASE_NEAR_USDC.refund_to,
    gasUsd: m2.base?.economics?.fee_usd_approx || 0.01,
    amount: m2.route?.amount || "997398",
  },
]) {
  const shadow = await shadowQuoteRoute({
    ...r,
    slipBps: 50,
    routeAllowlisted: true,
    state: paperState,
    limits: paperState.limits,
  });
  if (shadow.ok) {
    recordPaperTrade(paperState, {
      candidate: shadow.candidate,
      decision: shadow.decision,
    });
  }
  paperRoutes.push(shadow);
}

const report = {
  checkpoint: "J9_FULL_PREFLIGHT",
  baseline: "09b91b5",
  recorded_at: new Date().toISOString(),
  mutations_invoked: false,
  hard_stop: true,
  mission1: {
    verdict: m1.verdict,
    status: m1.status,
    blockers: m1.blockers,
    quote_min_out: m1.quote?.min_amount_out,
    policy_fit: m1.quote?.policy_fit?.result,
  },
  mission2: {
    route: "base_usdc_to_near_usdc",
    verdict: m2.verdict,
    status: m2.status,
    blockers: m2.blockers,
    warnings: m2.warnings,
    amount: m2.route?.amount,
    amount_label: m2.route?.amount_label,
    base_usdc: m2.balances?.base_usdc_raw,
    base_eth: m2.balances?.base_eth,
    quote_min_out: m2.quote?.min_amount_out,
    policy_fit: m2.quote?.policy_fit?.result,
    economics: m2.base?.economics,
    storage_shared: m2.near_destination?.register_once,
  },
  route_matrix: matrix,
  funding,
  paper: {
    funded_disabled: paperGate,
    shadows: paperRoutes.map((s) =>
      s.ok
        ? {
            route: s.candidate.route_id,
            decision: s.decision.action,
            reasons: s.decision.reasons,
            edge_bps: s.candidate.edge_bps,
            net_usdc: s.candidate.net_usdc,
            policy_fit: s.candidate.policy_fit,
          }
        : { ok: false, reason: s.reason }
    ),
    daily: paperState.daily,
  },
  approvals_required: [
    "Coordinated funding per funding.rows / totals / funding_order",
    "ONE NEAR USDC storage_deposit for nishanthb.near (covers M1+M2)",
    "New Mission1 operation approval (never reuse J8B)",
    "New Mission2 Base→NEAR operation approval (never reuse J8B/M1)",
    "Per-mission Ledger unpause + propose/sign/broadcast",
    "Per-mission reconcile_pending after settlement verify",
    "Base→Eth remains DEFERRED without separate approval",
    "Autonomous funded trading remains DISABLED",
  ],
};

writeFileSync(
  join(outDir, "MAINNET_CHECKPOINT_J9_FULL_PREFLIGHT.json"),
  JSON.stringify(report, null, 2) + "\n"
);
writeFileSync(join(outDir, "MAINNET_CHECKPOINT_J9_M1_DRY.json"), JSON.stringify(m1, null, 2) + "\n");
writeFileSync(join(outDir, "MAINNET_CHECKPOINT_J9_M2_DRY.json"), JSON.stringify(m2, null, 2) + "\n");
writeFileSync(join(outDir, "MAINNET_CHECKPOINT_J9_ROUTE_MATRIX.json"), JSON.stringify(matrix, null, 2) + "\n");
writeFileSync(join(outDir, "MAINNET_CHECKPOINT_J9_FUNDING_PLAN.json"), JSON.stringify(funding, null, 2) + "\n");
writeFileSync(
  join(outDir, "MAINNET_CHECKPOINT_J9_PAPER.json"),
  JSON.stringify({ paperGate, shadows: report.paper.shadows, daily: paperState.daily }, null, 2) + "\n"
);

function mdRow(r) {
  return `| ${r.chain} | ${r.asset} | \`${r.recipient}\` | ${r.current_ui ?? r.current_raw} | ${r.amount_needed_ui ?? r.amount_needed_raw} | ${r.top_up_ui ?? r.top_up_raw} | ${r.buffer_note || ""} | ${r.source_of_funds || ""} |`;
}

const md = `# Checkpoint J9 — Full multichain preflight (Base→NEAR Mission 2)

**Mutations invoked:** false  
**Hard stop:** funding / Ledger / unpause / propose / sign / broadcast / autonomous funded trading

Baseline: \`09b91b5\`

## 1. Ethereum → NEAR (Mission 1)

- **Verdict:** ${m1.verdict} / \`${m1.status}\`
- Dry min_out: \`${m1.quote?.min_amount_out}\` policy=${m1.quote?.policy_fit?.result}
- **Blockers:** ${(m1.blockers || []).join("; ") || "none"}

## 2. Base → NEAR USDC (Mission 2 — active)

- **Verdict:** ${m2.verdict}
- Live Base USDC: \`${m2.balances?.base_usdc_raw}\` (J8B leftover rechecked)
- Proposed amount: **${m2.route?.amount_label || "n/a"}** (\`${m2.route?.amount}\`)
- Recipient: \`nishanthb.near\` — NEP-141 USDC (shared storage with M1, register once)
- Dry min_out: \`${m2.quote?.min_amount_out}\` policy=${m2.quote?.policy_fit?.result}
- Base gas: ${m2.base?.economics?.verdict} ≈ $${m2.base?.economics?.fee_usd_approx?.toFixed?.(4)}
- **Blockers:** ${(m2.blockers || []).join("; ") || "none"}
- **Warnings:** ${(m2.warnings || []).join("; ") || "none"}
- Base → Ethereum: **DEFERRED** (structural withdraw fee)

## 3. Other route feasibility

| Route | Feasibility | Policy | Scope |
|-------|-------------|--------|-------|
${matrix.rows
  .map(
    (r) =>
      `| ${r.id} | ${r.feasibility} | ${r.policy_fit} | ${r.funded_scope} |`
  )
  .join("\n")}

## 4. Consolidated funding checklist

| Chain | Asset | Recipient | Current | Needed | Top-up | Buffer / note | From |
|-------|-------|-----------|---------|--------|--------|---------------|------|
${funding.rows.map(mdRow).join("\n")}

**Totals:** Eth USDC +${funding.totals.eth_usdc_top_up}, Eth gas +${funding.totals.eth_gas_top_up_eth} ETH, Base USDC +${funding.totals.base_usdc_top_up}, Base gas +${funding.totals.base_gas_top_up_eth} ETH, NEAR storage ${funding.totals.near_storage_near} NEAR (once). M2: \`${funding.totals.m2_strategy}\` @ ${funding.totals.m2_proposed_amount_usdc} USDC.

**Funding order:**
${(funding.funding_order || []).map((x) => `- ${x}`).join("\n")}

## 5. Paper trading

- Funded autonomous: **DISABLED** (ok=${paperGate.ok})
- Shadows: ${report.paper.shadows.map((s) => `${s.route}:${s.decision}`).join(", ")}

## 6. Approvals required

${report.approvals_required.map((x) => `- ${x}`).join("\n")}

MPC: \`${MAINNET_IDENTITIES.mpc_evm_address}\`  
Owner: \`${MAINNET_IDENTITIES.owner}\`
`;

writeFileSync(join(outDir, "MAINNET_CHECKPOINT_J9_FULL_PREFLIGHT.md"), md);
console.log(
  JSON.stringify(
    {
      verdict: "PREFLIGHT_COMPLETE_AWAITING_FUNDING",
      m1: m1.verdict,
      m2: m2.verdict,
      m2_amount: m2.route?.amount,
      funding_blockers: funding.blockers,
      paper_funded: false,
    },
    null,
    2
  )
);
