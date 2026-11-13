#!/usr/bin/env node
/**
 * Checkpoint J5.2 — find one policy-compatible live USDC→USDC quote.
 * No funding, deposit, Ledger, attestor registration, or broadcast.
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  scanDryQuoteMatrix,
  fetchMatchingNonDryQuote,
  diagnoseScanFailure,
  POLICY_SLIPPAGE_BPS,
  MAX_TRADE_VALUE_RAW,
} from "../../packages/mainnet/j5_2.quoteScan.mjs";
import { MPC_EVM } from "../../packages/mainnet/quotePath.mjs";
import { attestorDesignSummary } from "../../packages/mainnet/attestorDesign.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, "docs/evidence");
mkdirSync(OUT, { recursive: true });
const sdkPkg = JSON.parse(
  readFileSync(
    join(ROOT, "node_modules/@defuse-protocol/one-click-sdk-typescript/package.json"),
    "utf8"
  )
);

function sanitizeResponse(resp) {
  if (!resp) return null;
  return {
    quoteRequest: resp.quoteRequest,
    quote: resp.quote,
    timestamp: resp.timestamp,
    correlationId: resp.correlationId,
    signature_present: Boolean(resp.signature),
    signature_prefix: resp.signature
      ? String(resp.signature).slice(0, 24) + "…"
      : null,
  };
}

async function main() {
  process.env.NIO_NETWORK = "mainnet";
  process.env.NEAR_NETWORK = "mainnet";
  const at = new Date().toISOString();
  console.error("[j5.2] scanning dry matrix…");

  const scan = await scanDryQuoteMatrix({ delayMs: 120 });
  const diagnosis = diagnoseScanFailure(scan);
  console.error(
    `[j5.2] scanned=${scan.scanned} pass=${scan.pass_count} blocked=${scan.blocked_count}`
  );

  const target = scan.recommended_first_tiny || scan.best;
  let nondry = null;
  if (target) {
    console.error(
      `[j5.2] target dry PASS ${target.route_id} slip=${target.slippage_tolerance_bps} amount=${target.amount_usdc} — fetching non-dry (no deposit)`
    );
    nondry = await fetchMatchingNonDryQuote(target);
    console.error(
      `[j5.2] nondry status=${nondry.classified?.status} escrow=${Boolean(nondry.classified?.deposit_address)}`
    );
  }

  const j6 =
    nondry?.ok && nondry.classified?.status === "PASS"
      ? {
          title: "J6 — Attestor registration plan (REQUIRES SEPARATE APPROVAL)",
          do_not_execute_now: true,
          steps: [
            "Generate isolated ed25519 attestor key offline (never commit seed)",
            "Owner Ledger: call set_trusted_quote_signer(ed25519:<pk>) on policy.nishanthb.near",
            "Verify is_trusted_quote_signer returns true",
            "Keep policy paused=true until J7 funding + explicit unpause approval",
            "Do not broadcast, deposit, or unpause in J6",
          ],
          on_chain_method: "set_trusted_quote_signer",
          attestor: attestorDesignSummary(),
        }
      : {
          title: "J6 deferred — no fully policy-compatible non-dry quote",
          do_not_execute_now: true,
        };

  const j7 =
    nondry?.ok && nondry.classified?.status === "PASS"
      ? {
          title: "J7 — Minimum gas/USDC funding plan (REQUIRES SEPARATE APPROVAL)",
          do_not_execute_now: true,
          mpc_evm: MPC_EVM,
          source_chain: nondry.classified.source_chain,
          suggested_usdc_raw: nondry.classified.amount_in_raw,
          suggested_usdc_ui: nondry.classified.amount_usdc,
          gas: nondry.classified.gas,
          notes: [
            "Fund ONLY the MPC EVM address on the chosen source chain",
            "USDC amount exactly matching the approved quote size (≤ max_trade_value 5 USDC)",
            "Gas: L2 preferred — tiny native ETH/ETH-equivalent for ERC-20 transfer only",
            "No deposit to 1Click escrow until after attestor registered + explicit execute approval",
            "Keep autonomous=false, broadcast gate off until execute checklist signed off",
          ],
        }
      : {
          title: "J7 deferred — awaiting PASS non-dry quote",
          do_not_execute_now: true,
        };

  const evidence = {
    checkpoint: "J5.2",
    at,
    node: process.version,
    sdk: sdkPkg.version,
    safety: {
      ledger: false,
      mainnet_mutations: false,
      evm_funding: false,
      escrow_deposits: false,
      attestor_registration: false,
      unpause: false,
      autonomous: false,
      broadcast: false,
      tls_bypass: false,
      values_altered: false,
      max_trade_value_raw: String(MAX_TRADE_VALUE_RAW),
      policy_slippage_bps: POLICY_SLIPPAGE_BPS,
    },
    scan_summary: {
      scanned: scan.scanned,
      pass_count: scan.pass_count,
      blocked_count: scan.blocked_count,
      hypothesis: scan.hypothesis,
      diagnosis,
    },
    best_dry: scan.best
      ? {
          ...scan.best,
          one_click_response: sanitizeResponse(scan.best.one_click_response),
        }
      : null,
    recommended_first_tiny: scan.recommended_first_tiny
      ? {
          ...scan.recommended_first_tiny,
          one_click_response: sanitizeResponse(
            scan.recommended_first_tiny.one_click_response
          ),
        }
      : null,
    nondry_matched_to: target
      ? {
          route_id: target.route_id,
          amount_usdc: target.amount_usdc,
          slip: target.slippage_tolerance_bps,
        }
      : null,
    nondry: nondry
      ? {
          ok: nondry.ok,
          deposit_sent: false,
          classified: {
            ...nondry.classified,
            one_click_response: sanitizeResponse(
              nondry.classified?.one_click_response
            ),
          },
        }
      : null,
    // Compact row table without bulky bodies
    dry_rows: scan.rows.map((r) => ({
      route_id: r.route_id,
      amount_usdc: r.amount_usdc,
      slip: r.slippage_tolerance_bps,
      status: r.status,
      reasons: r.reasons,
      min_out: r.min_amount_out_raw,
      floor: r.policy_floor,
      out_usd: r.amount_out_usd,
      fee_usd: r.routing_fee_usd_estimate,
      sig: r.signature_verified,
      source: r.source_chain,
    })),
    j6_attestor_plan: j6,
    j7_funding_plan: j7,
    next_operator_action: nondry?.ok
      ? "Review J6 attestor-registration plan and approve separately before any Ledger set_trusted_quote_signer call"
      : "Do not proceed to J6 — no policy-compatible live quote; address fee/slip structure without weakening on-chain max_slippage_bps",
  };

  writeFileSync(
    join(OUT, "MAINNET_CHECKPOINT_J5_2.json"),
    JSON.stringify(evidence, null, 2)
  );
  writeFileSync(join(OUT, "MAINNET_CHECKPOINT_J5_2.md"), renderMd(evidence));
  console.log(
    JSON.stringify(
      {
        dry_pass: scan.pass_count,
        best: scan.best
          ? {
              route: scan.best.route_id,
              slip: scan.best.slippage_tolerance_bps,
              amount: scan.best.amount_usdc,
              minOut: scan.best.min_amount_out_raw,
              floor: scan.best.policy_floor,
              status: scan.best.status,
            }
          : null,
      recommended_first_tiny: scan.recommended_first_tiny
          ? {
              route: scan.recommended_first_tiny.route_id,
              slip: scan.recommended_first_tiny.slippage_tolerance_bps,
              amount: scan.recommended_first_tiny.amount_usdc,
              minOut: scan.recommended_first_tiny.min_amount_out_raw,
              floor: scan.recommended_first_tiny.policy_floor,
              status: scan.recommended_first_tiny.status,
            }
          : null,
        nondry: nondry?.classified?.status || null,
        next: evidence.next_operator_action,
      },
      null,
      2
    )
  );
}

function renderMd(e) {
  const b = e.best_dry;
  const n = e.nondry?.classified;
  return `# Checkpoint J5.2 — Policy-compatible live quote search

**No funding / deposit / Ledger / attestor / unpause / broadcast**

## Best dry quote

${
  b
    ? `| Field | Value |
|-------|-------|
| Route | ${b.route_id} (${b.source_chain} → ${b.destination_chain}) |
| Input | ${b.amount_usdc} USDC (${b.amount_in_raw} raw) |
| amountOut | ${b.amount_out_raw} |
| minAmountOut | ${b.min_amount_out_raw} |
| Slippage requested | ${b.slippage_tolerance_bps} bps |
| Policy floor (100 bps) | ${b.policy_floor} |
| Signature verify | ${b.signature_verified ? "PASS" : "FAIL"} |
| Status | **${b.status}** |
| Fee USD est. | ${b.routing_fee_usd_estimate} |
| Gas | ${b.gas?.source_gas_affordability} / within budget ${b.gas?.within_max_gas_budget} |`
    : "_None — all dry quotes BLOCKED_"
}

## Non-dry (no deposit)

${
  n
    ? `Status **${n.status}** · escrow \`${n.deposit_address || "none"}\` · escrow_in_signed_hash=${n.escrow_in_signed_hash} · reasons: ${(n.reasons || []).join(", ") || "none"}`
    : "_Skipped — no dry PASS_"
}

## Scan

Scanned **${e.scan_summary.scanned}** · PASS **${e.scan_summary.pass_count}** · BLOCKED **${e.scan_summary.blocked_count}**

Diagnosis: ${e.scan_summary.diagnosis?.assessment || "n/a"}

## Next operator action (J6)

${e.next_operator_action}
`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
