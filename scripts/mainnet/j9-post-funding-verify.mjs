#!/usr/bin/env node
/**
 * J9 post-funding verification + Mission 1 readiness (read-only).
 * HARD STOP: no unpause / propose / sign / broadcast / swap / reconcile / mandate mods.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { runMission1EthNearPreflight } from "../../packages/mainnet/mission1EthNear.mjs";
import { runMission2BaseNearPreflight } from "../../packages/mainnet/mission2BaseNear.mjs";
import { createViewOnlyPolicyAdapters } from "../../packages/mainnet/canaryRecovery.mjs";
import { MAINNET_IDENTITIES } from "../../packages/mainnet/identities.mjs";
import { secureFetch, detectMobileBindAddress } from "../../packages/mainnet/secureFetch.mjs";
import {
  buildMission1ApprovalPreview,
  buildMission1TransactionPlan,
  auditMission1ProductionPathWithRunner,
} from "../../packages/mainnet/mission1ExecutionPath.mjs";
import {
  assertMission1RunnerComplete,
  mission1RunnerCapabilities,
} from "../../packages/mainnet/mission1Executor.mjs";
import {
  resolveCanarySettlementPlan,
} from "../../packages/mainnet/canarySettlement.mjs";
import { M1_ETH_NEAR_USDC, M2_BASE_NEAR_USDC } from "../../packages/mainnet/canaryRouteProfiles.mjs";
import {
  assertPaperFundedDisabled,
  createPaperState,
  shadowQuoteRoute,
  PAPER_DEFAULT_LIMITS,
} from "../../packages/mainnet/paperTrading.mjs";

const outDir = join("docs", "evidence");
mkdirSync(outDir, { recursive: true });
const baseline = "b0afa50e0b385f0952f157db427c118efc354263";

function ifaceSummary() {
  const nets = networkInterfaces();
  const out = {};
  for (const [name, addrs] of Object.entries(nets)) {
    out[name] = (addrs || [])
      .filter((a) => a.family === "IPv4" || a.family === 4)
      .map((a) => a.address);
  }
  return out;
}

async function probeOneClickTls() {
  const bind = detectMobileBindAddress(process.env);
  const r = await secureFetch("https://1click.chaindefuser.com/v0/tokens", {
    method: "GET",
    timeoutMs: 20_000,
    env: process.env,
  });
  let mitm = null;
  try {
    const { default: tls } = await import("node:tls");
    const { connect } = await import("node:net");
    mitm = await new Promise((resolve) => {
      const socket = connect({ host: "1click.chaindefuser.com", port: 443, family: 4 }, () => {
        const secure = tls.connect({
          socket,
          servername: "1click.chaindefuser.com",
          rejectUnauthorized: false,
        }, () => {
          const cert = secure.getPeerCertificate();
          resolve({
            subject: cert?.subject,
            issuer: cert?.issuer,
            fortinet_mitm: String(cert?.issuer?.O || "").includes("Fortinet"),
          });
          secure.end();
        });
        secure.on("error", (e) => resolve({ error: String(e.message || e) }));
      });
      socket.on("error", (e) => resolve({ error: String(e.message || e) }));
    });
  } catch (e) {
    mitm = { error: String(e.message || e) };
  }
  return {
    ok: r.ok,
    status: r.status,
    bind,
    error: r.error || null,
    fortinet_mitm: mitm?.fortinet_mitm ?? null,
    peer_issuer: mitm?.issuer || null,
  };
}

async function policyPendingAudit(adapters) {
  const body = async (method, args = {}) => {
    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: MAINNET_IDENTITIES.policy,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    };
    const res = await fetch(adapters.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await res.json();
    if (!j.result?.result) return null;
    return JSON.parse(Buffer.from(j.result.result).toString("utf8"));
  };
  const j8bOp = "j8b-canary-1794572720062-8db4f42a";
  const [exposure, list, pending, evidence] = await Promise.all([
    body("get_exposure_snapshot"),
    body("list_pending"),
    adapters.getPending(j8bOp),
    body("get_evidence_hash", { operation_id: j8bOp }),
  ]);
  const unresolved = Number(exposure?.unresolved_pending || 0);
  const nonTerminal = (list || []).filter(
    (p) =>
      !["Success", "Refunded", "Failed", "Expired", "Reconciled"].includes(
        String(p.settlement_state)
      )
  );
  return {
    j8b_operation_id: j8bOp,
    j8b_pending: pending,
    j8b_evidence_hash: evidence,
    exposure,
    list_pending: list,
    unresolved_pending: unresolved,
    blocking_pending: nonTerminal,
    j8b_reconciled_ok:
      pending?.settlement_state === "Success" &&
      unresolved === 0 &&
      Boolean(evidence),
  };
}

console.error("[j9-post] TLS probe…");
const tls = await probeOneClickTls();

console.error("[j9-post] Mission1 dry…");
const m1 = await runMission1EthNearPreflight();

console.error("[j9-post] Mission2 dry…");
const m2 = await runMission2BaseNearPreflight();

console.error("[j9-post] Policy pending audit…");
const adapters = await createViewOnlyPolicyAdapters({});
const pendingAudit = await policyPendingAudit(adapters);

console.error("[j9-post] Production path audit…");
const pathAudit = await auditMission1ProductionPathWithRunner();
const runner = assertMission1RunnerComplete();
const settleM1 = resolveCanarySettlementPlan(M1_ETH_NEAR_USDC);
const settleM2 = resolveCanarySettlementPlan(M2_BASE_NEAR_USDC);

const paperGate = assertPaperFundedDisabled(process.env);
const paperState = createPaperState({
  ...PAPER_DEFAULT_LIMITS,
  min_net_edge_bps: -500,
});
let paperShadows = [];
if (tls.ok) {
  for (const r of [
    {
      routeId: M1_ETH_NEAR_USDC.id,
      assetIn: M1_ETH_NEAR_USDC.asset_in,
      assetOut: M1_ETH_NEAR_USDC.asset_out,
      recipient: M1_ETH_NEAR_USDC.recipient,
      refundTo: M1_ETH_NEAR_USDC.refund_to,
      gasUsd: m1.ethereum?.economics?.fee_usd_approx || 0.03,
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
    // eslint-disable-next-line no-await-in-loop
    paperShadows.push(
      await shadowQuoteRoute({
        ...r,
        slipBps: 50,
        routeAllowlisted: true,
        state: paperState,
        limits: paperState.limits,
      })
    );
  }
} else {
  paperShadows = [{ ok: false, reason: "oneclick_tls_blocked" }];
}

const approvalPreview = buildMission1ApprovalPreview({
  maxSlippageBps: 50,
  maxGasPrice: m1.ethereum?.gas_price?.gas_price_wei || undefined,
});
const txPlan = buildMission1TransactionPlan({
  quote: m1.quote,
  gasEconomics: m1.ethereum?.economics,
  nonce: m1.ethereum?.nonce_pending,
  nearUsdcBefore: null,
});

const fundingOk = {
  eth_usdc: BigInt(m1.ethereum?.usdc_raw || 0) >= 1_000_000n,
  eth_gas: Number(m1.ethereum?.native_eth || 0) >= 0.0005,
  base_usdc: BigInt(m2.balances?.base_usdc_raw || 0) >= 1n,
  base_gas: Number(m2.balances?.base_eth || 0) >= 0.0001,
  near_storage: Boolean(m1.near_destination?.storage?.registered),
  policy_paused: m1.policy?.paused === true,
  epoch_2: Number(m1.policy?.mandate_epoch) === 2,
};

const quoteOk = Boolean(m1.quote?.ok) && m1.quote?.policy_fit?.result === "PASS";
const m2QuoteOk = Boolean(m2.quote?.ok) && m2.quote?.policy_fit?.result === "PASS";

const m1Blockers = [...(m1.blockers || [])];
if (!tls.ok) {
  m1Blockers.push(
    `oneclick_tls_blocked:${tls.error || "untrusted_root"}:fortinet_mitm=${tls.fortinet_mitm}`
  );
}
if (!pathAudit.ok) {
  for (const g of pathAudit.engineering_gaps) {
    m1Blockers.push(`path:${g}`);
  }
}
if (!runner.ok) {
  m1Blockers.push(`runner_incomplete:${(runner.missing || []).join(",")}`);
}
const engineeringGaps = [
  ...pathAudit.engineering_gaps,
  ...(tls.ok ? [] : ["fresh_1click_quotes_require_non_fortinet_path_or_installed_fg_ca"]),
  ...(m2QuoteOk ? [] : m2.blockers || []),
];

const m1Ready =
  fundingOk.eth_usdc &&
  fundingOk.eth_gas &&
  fundingOk.near_storage &&
  fundingOk.policy_paused &&
  fundingOk.epoch_2 &&
  pendingAudit.j8b_reconciled_ok &&
  pendingAudit.blocking_pending.length === 0 &&
  quoteOk &&
  tls.ok &&
  paperGate.ok &&
  pathAudit.ok &&
  runner.ok;

const m2Ready =
  fundingOk.base_usdc &&
  fundingOk.base_gas &&
  fundingOk.near_storage &&
  fundingOk.policy_paused &&
  m2QuoteOk &&
  tls.ok &&
  paperGate.ok;

const report = {
  checkpoint: "J9_POST_FUNDING_VERIFY",
  baseline,
  recorded_at: new Date().toISOString(),
  mutations_invoked: false,
  hard_stop: true,
  network: {
    bind: tls.bind,
    interfaces: ifaceSummary(),
    oneclick_tls: tls,
  },
  funding_live: fundingOk,
  balances: {
    ethereum: {
      usdc_raw: m1.ethereum?.usdc_raw,
      eth: m1.ethereum?.native_eth,
      nonce_latest: m1.ethereum?.nonce_latest,
      nonce_pending: m1.ethereum?.nonce_pending,
      gas: m1.ethereum?.economics,
    },
    base: {
      usdc_raw: m2.balances?.base_usdc_raw,
      eth: m2.balances?.base_eth,
      gas: m2.base?.economics,
    },
    near_storage: m1.near_destination?.storage,
  },
  policy: {
    paused: m1.policy?.paused,
    mandate_epoch: m1.policy?.mandate_epoch,
    max_trade_value: m1.policy?.max_trade_value,
    max_slippage_bps: m1.policy?.max_slippage_bps,
  },
  pending_audit: pendingAudit,
  mission1: {
    verdict: m1Ready ? "READY" : "NO-GO",
    dry_verdict: m1.verdict,
    blockers: m1Blockers,
    warnings: m1.warnings,
    quote: {
      ok: m1.quote?.ok,
      amount_out: m1.quote?.amount_out,
      min_amount_out: m1.quote?.min_amount_out,
      deposit_address: m1.quote?.deposit_address,
      deadline: m1.quote?.deadline,
      policy_fit: m1.quote?.policy_fit,
      dry: m1.quote?.dry,
    },
    settlement_plan: settleM1,
  },
  mission2: {
    verdict: m2Ready ? "READY" : "NO-GO",
    dry_verdict: m2.verdict,
    blockers: m2.blockers,
    warnings: m2.warnings,
    amount: m2.route?.amount,
    quote: {
      ok: m2.quote?.ok,
      min_amount_out: m2.quote?.min_amount_out,
      policy_fit: m2.quote?.policy_fit,
    },
    settlement_plan: settleM2,
  },
  production_path: pathAudit,
  mission1_runner: {
    complete: runner.ok,
    capabilities: mission1RunnerCapabilities(),
    steps: runner.steps,
  },
  paper: {
    funded_disabled: paperGate,
    shadows: paperShadows.map((s) =>
      s.ok
        ? { route: s.candidate.route_id, decision: s.decision.action }
        : { ok: false, reason: s.reason }
    ),
  },
  mission1_approval_preview: {
    persisted: false,
    operation_id_suggested: approvalPreview.operation_id,
    payload: approvalPreview.payload,
    transaction_plan: txPlan,
    requires_explicit_financial_approval: true,
    this_preflight_is_not_trade_approval: true,
  },
  engineering_gaps: engineeringGaps,
  approvals_required_before_trade: [
    "Restore non-MITM path for 1Click (mobile hotspot / FortiGate CA) and re-fetch funded quotes",
    "Explicit Mission 1 financial approval (new op id — never reuse J8B)",
    "Ledger unpause window",
    "propose_quoted_evm_transfer / request_signature / Ethereum broadcast",
    "Settlement verify (Eth receipt + 1Click SUCCESS + NEAR NEP-141 delta)",
    "Ledger reconcile_pending + pause",
    "Separate Mission 2 approval after M1",
  ],
};

writeFileSync(
  join(outDir, "MAINNET_CHECKPOINT_J9_POST_FUNDING.json"),
  JSON.stringify(report, null, 2) + "\n"
);
writeFileSync(join(outDir, "MAINNET_CHECKPOINT_J9_M1_DRY.json"), JSON.stringify(m1, null, 2) + "\n");
writeFileSync(join(outDir, "MAINNET_CHECKPOINT_J9_M2_DRY.json"), JSON.stringify(m2, null, 2) + "\n");

const md = `# Checkpoint J9 — Post-funding verification

**Mutations invoked:** false  
**Hard stop:** unpause / propose / sign / broadcast / swap / reconcile / mandate mods  
**Baseline:** \`${baseline}\`

## Verdicts

| Mission | Verdict | Why |
|---------|---------|-----|
| Mission 1 Eth→NEAR | **${report.mission1.verdict}** | ${(m1Blockers.length ? m1Blockers.join("; ") : "funding+policy+quote clear")} |
| Mission 2 Base→NEAR | **${report.mission2.verdict}** | ${((m2.blockers || []).join("; ") || (tls.ok ? "ok" : "oneclick_tls_blocked"))} |

## Live funding / policy

| Check | Value |
|-------|-------|
| Eth MPC USDC | ${m1.ethereum?.usdc_raw} (≥1e6: ${fundingOk.eth_usdc}) |
| Eth MPC ETH | ${m1.ethereum?.native_eth} (≥0.0005: ${fundingOk.eth_gas}) |
| Base MPC USDC | ${m2.balances?.base_usdc_raw} |
| Base MPC ETH | ${m2.balances?.base_eth} (≥0.0001: ${fundingOk.base_gas}) |
| NEAR USDC storage | registered=${fundingOk.near_storage} |
| Policy paused | ${m1.policy?.paused} epoch=${m1.policy?.mandate_epoch} |
| J8B pending | settlement=${pendingAudit.j8b_pending?.settlement_state} unresolved=${pendingAudit.unresolved_pending} |
| Eth gas fee est | ≈$${m1.ethereum?.economics?.fee_usd_approx} (${m1.ethereum?.economics?.verdict}) |
| Base gas fee est | ≈$${m2.base?.economics?.fee_usd_approx} (${m2.base?.economics?.verdict}) |
| 1Click TLS | ok=${tls.ok} fortinet_mitm=${tls.fortinet_mitm} error=${tls.error || "none"} |

## Mission 1 approval preview (NOT an authorization)

- Suggested op id: \`${approvalPreview.operation_id}\` (not persisted)
- Amount: 1 USDC (\`1000000\`) Eth native USDC → NEP-141 USDC @ \`nishanthb.near\`
- Signer: \`${MAINNET_IDENTITIES.mpc_evm_address}\`
- Slippage request: 50 bps (policy max 100)
- Dry min_out: \`${m1.quote?.min_amount_out || "n/a — quote blocked"}\`
- Steps: Ledger unpause → propose_quoted_evm_transfer → request_signature → Eth broadcast → settle verify → Ledger reconcile → pause

## Engineering gaps

${engineeringGaps.map((g) => `- ${g}`).join("\n")}

## Production path components ready

${(pathAudit.production_ready_components || []).map((x) => `- ${x}`).join("\n")}

Paper funded autonomous: **DISABLED** (ok=${paperGate.ok})
`;

writeFileSync(join(outDir, "MAINNET_CHECKPOINT_J9_POST_FUNDING.md"), md);

console.log(
  JSON.stringify(
    {
      m1: report.mission1.verdict,
      m2: report.mission2.verdict,
      tls_ok: tls.ok,
      fortinet_mitm: tls.fortinet_mitm,
      fundingOk,
      j8b_ok: pendingAudit.j8b_reconciled_ok,
      evidence: "docs/evidence/MAINNET_CHECKPOINT_J9_POST_FUNDING.json",
    },
    null,
    2
  )
);
