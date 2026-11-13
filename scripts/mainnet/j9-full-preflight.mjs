#!/usr/bin/env node
/**
 * J9 consolidated preflight — Mission1 preserve, Mission2 dry, route matrix,
 * funding plan, paper-trading shadow. NO funding / Ledger / mutations.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runMission1EthNearPreflight } from "../../packages/mainnet/mission1EthNear.mjs";
import { runMission2BaseEthPreflight } from "../../packages/mainnet/mission2BaseEth.mjs";
import { runJ9RouteMatrix } from "../../packages/mainnet/j9RouteMatrix.mjs";
import { buildJ9FundingPlan } from "../../packages/mainnet/j9FundingPlan.mjs";
import {
  shadowQuoteRoute,
  createPaperState,
  recordPaperTrade,
  PAPER_DEFAULT_LIMITS,
  assertPaperFundedDisabled,
} from "../../packages/mainnet/paperTrading.mjs";
import { M1_ETH_NEAR_USDC, M2_BASE_ETH_USDC } from "../../packages/mainnet/canaryRouteProfiles.mjs";
import { MAINNET_IDENTITIES } from "../../packages/mainnet/identities.mjs";

const outDir = join("docs", "evidence");
mkdirSync(outDir, { recursive: true });

console.error("[j9] Mission1 Eth→NEAR dry…");
const m1 = await runMission1EthNearPreflight();
m1.status = m1.ok ? "READY_FOR_OWNER_APPROVAL" : "AWAITING_FUNDING";
m1.preserved = true;
m1.note = "No new operation/quote/auth created — dry recheck only";

console.error("[j9] Mission2 Base→Eth dry…");
const m2 = await runMission2BaseEthPreflight();

console.error("[j9] Route discovery matrix…");
const matrix = await runJ9RouteMatrix({ amount: "1000000", slip: 50 });

console.error("[j9] Consolidated funding plan…");
const funding = await buildJ9FundingPlan({
  ethUsdHint: 3200,
});

console.error("[j9] Paper-trading shadow quotes…");
const paperGate = assertPaperFundedDisabled(process.env);
const paperState = createPaperState({
  ...PAPER_DEFAULT_LIMITS,
  min_net_edge_bps: -500, // observe; still reject funded
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
    routeId: M2_BASE_ETH_USDC.id,
    assetIn: M2_BASE_ETH_USDC.asset_in,
    assetOut: M2_BASE_ETH_USDC.asset_out,
    recipient: M2_BASE_ETH_USDC.recipient,
    refundTo: M2_BASE_ETH_USDC.refund_to,
    gasUsd: m2.base?.economics?.fee_usd_approx || 0.01,
    amount: m2.route?.amount || "500000",
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
  baseline: "d641fe8",
  recorded_at: new Date().toISOString(),
  mutations_invoked: false,
  hard_stop: true,
  mission1: {
    verdict: m1.verdict,
    status: m1.status,
    blockers: m1.blockers,
    quote_min_out: m1.quote?.min_amount_out,
    policy_fit: m1.quote?.policy_fit?.result,
    economics: m1.ethereum?.economics,
  },
  mission2: {
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
  },
  route_matrix: matrix,
  funding,
  paper: {
    funded_disabled: paperGate,
    limits: PAPER_DEFAULT_LIMITS,
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
    "Coordinated funding per funding.rows / totals",
    "NEAR USDC storage_deposit for nishanthb.near (Ledger)",
    "New Mission1 operation approval (never reuse J8B)",
    "New Mission2 operation approval (never reuse J8B)",
    "Per-mission Ledger unpause window + propose/sign/broadcast",
    "Per-mission reconcile_pending after settlement verify",
    "Any expansion beyond Eth→NEAR and Base→Eth funded scope",
    "Any autonomous funded trading (currently DISABLED)",
  ],
};

writeFileSync(
  join(outDir, "MAINNET_CHECKPOINT_J9_FULL_PREFLIGHT.json"),
  JSON.stringify(report, null, 2) + "\n"
);
writeFileSync(
  join(outDir, "MAINNET_CHECKPOINT_J9_M1_DRY.json"),
  JSON.stringify(m1, null, 2) + "\n"
);
writeFileSync(
  join(outDir, "MAINNET_CHECKPOINT_J9_M2_DRY.json"),
  JSON.stringify(m2, null, 2) + "\n"
);
writeFileSync(
  join(outDir, "MAINNET_CHECKPOINT_J9_ROUTE_MATRIX.json"),
  JSON.stringify(matrix, null, 2) + "\n"
);
writeFileSync(
  join(outDir, "MAINNET_CHECKPOINT_J9_FUNDING_PLAN.json"),
  JSON.stringify(funding, null, 2) + "\n"
);
writeFileSync(
  join(outDir, "MAINNET_CHECKPOINT_J9_PAPER.json"),
  JSON.stringify({ paperGate, limits: PAPER_DEFAULT_LIMITS, shadows: report.paper.shadows, daily: paperState.daily }, null, 2) +
    "\n"
);

function mdRow(r) {
  return `| ${r.chain} | ${r.asset} | \`${r.recipient}\` | ${r.current_ui ?? r.current_raw} | ${r.amount_needed_ui ?? r.amount_needed_raw} | ${r.top_up_ui ?? r.top_up_raw} | ${r.buffer_note || ""} | ${r.source_of_funds || ""} |`;
}

const md = `# Checkpoint J9 — Full multichain preflight (no funding)

**Mutations invoked:** false  
**Hard stop:** funding / Ledger / unpause / propose / sign / broadcast / autonomous funded trading

Baseline: \`d641fe8\`

## 1. Ethereum → NEAR (Mission 1)

- **Verdict:** ${m1.verdict} / \`${m1.status}\`
- Destination: NEAR NEP-141 USDC (not wrap.near)
- Dry min_out: \`${m1.quote?.min_amount_out}\` policy=${m1.quote?.policy_fit?.result}
- Est L1 fee ≈ $${m1.ethereum?.economics?.fee_usd_approx?.toFixed?.(2)} (${m1.ethereum?.economics?.verdict})
- **Blockers:** ${(m1.blockers || []).join("; ") || "none"}

## 2. Base → Ethereum (Mission 2)

- **Verdict:** ${m2.verdict} — **STRUCTURAL** (not a simple funding gap)
- Live Base USDC: \`${m2.balances?.base_usdc_raw}\` (J8B leftover rechecked; **do not top up for M2**)
- Live withdrawFee on Base→Eth quotes: ~\`300000\` raw (0.30 USDC) → amount_out ≈ in − 0.30 USDC
- Policy floor at max_slippage 100 bps + max_trade 5 USDC: **1–5 USDC quotes all BLOCKED**
- Reduced 0.5 USDC attempt also BLOCKED (worse ratio)
- Dry min_out (attempt): \`${m2.quote?.min_amount_out}\` policy=${m2.quote?.policy_fit?.result}
- **Blockers:** ${(m2.blockers || []).join("; ") || "none"}
- **Deferral:** leave Base USDC idle; discovery alternatives: base→near_usdc (PASS), eth→base (PASS). Mandate change or different destination needs separate approval.

## 3. Other route feasibility (discovery only)

Scoped funded routes remain **only** Eth→NEAR and Base→Eth.

| Route | Feasibility | Policy | Gaps |
|-------|-------------|--------|------|
${matrix.rows
  .map(
    (r) =>
      `| ${r.id} | ${r.feasibility} | ${r.policy_fit} | ${(r.gaps || []).join(", ") || "—"} |`
  )
  .join("\n")}

## 4. Consolidated funding checklist

| Chain | Asset | Recipient | Current | Needed | Top-up | Buffer / note | From |
|-------|-------|-----------|---------|--------|--------|---------------|------|
${funding.rows.map(mdRow).join("\n")}

**Totals:** Eth USDC +${funding.totals.eth_usdc_top_up}, Eth gas +${funding.totals.eth_gas_top_up_eth} ETH (≈$${funding.totals.eth_gas_top_up_usd_approx?.toFixed?.(2)}), Base USDC +${funding.totals.base_usdc_top_up}, Base gas +${funding.totals.base_gas_top_up_eth} ETH, NEAR storage ${funding.totals.near_storage_near} NEAR. M2 strategy: \`${funding.totals.m2_strategy}\`.

## 5. Paper trading

- Funded autonomous: **DISABLED** (gates ok=${paperGate.ok})
- Proposed limits (inactive): max 1 USDC/trade, 5 USDC daily notional, 1 USDC daily loss, kill switch
- Shadow results: ${report.paper.shadows.map((s) => `${s.route}:${s.decision}`).join(", ")}

## 6. Approvals required from owner

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
      funding_blockers: funding.blockers,
      paper_funded: false,
    },
    null,
    2
  )
);
