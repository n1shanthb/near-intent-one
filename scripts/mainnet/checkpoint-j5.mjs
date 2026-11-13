#!/usr/bin/env node
/**
 * Checkpoint J5.1 — live quote verification + policy compatibility (no execution).
 * No mainnet mutations, funding, broadcast, Ledger, or attestor registration.
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { productionDryQuote } from "../../packages/mainnet/intents.mjs";
import {
  SDK_SIGNATURE_COVERAGE,
  ONE_CLICK_MANAGER_PUB_KEY,
  mutateQuoteResponse,
  verifySignedOneClickQuote,
} from "../../packages/intents-codec/oneClickVerify.mjs";
import {
  ASSETS,
  MPC_EVM,
  MAINNET_EPOCH,
  runLocalQuoteAuthorizationPath,
  evaluateLiveMinOutAgainstPolicy,
  policySlippageFloorOk,
  simulatePolicyChecks,
  buildErc20TxParams,
} from "../../packages/mainnet/quotePath.mjs";
import { buildDecimalsRiskReport } from "../../packages/mainnet/decimalsRisk.mjs";
import { attestorDesignSummary } from "../../packages/mainnet/attestorDesign.mjs";
import { MAINNET_IDENTITIES } from "../../packages/mainnet/identities.mjs";
import { detectMobileBindAddress } from "../../packages/mainnet/secureFetch.mjs";
import { pickRpc, viewFunction } from "../../packages/networks/rpc.mjs";
import { MAINNET } from "../../packages/networks/profiles.mjs";
import tls from "node:tls";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, "docs/evidence");
mkdirSync(OUT, { recursive: true });

const OWNER_NEAR = MAINNET_IDENTITIES.owner || "nishanthb.near";
const sdkPkg = JSON.parse(
  readFileSync(
    join(ROOT, "node_modules/@defuse-protocol/one-click-sdk-typescript/package.json"),
    "utf8"
  )
);

function probeTlsHost(host) {
  return new Promise((resolve) => {
    const localAddress = detectMobileBindAddress();
    const opts = {
      host,
      port: 443,
      servername: host,
      rejectUnauthorized: true,
    };
    // Prefer unbound connect if mobile bind EINVAL (stale NIC)
    const tryConnect = (useBind) => {
      const socket = tls.connect(
        { ...opts, ...(useBind && localAddress ? { localAddress } : {}) },
        () => {
          const c = socket.getPeerCertificate();
          const authorized = socket.authorized;
          socket.end();
          resolve({
            ok: authorized,
            bind: useBind ? localAddress : null,
            subject: c.subject?.CN || null,
            issuerCN: c.issuer?.CN || null,
            issuerO: c.issuer?.O || null,
            fingerprint256: c.fingerprint256 || null,
            fortinet_mitm: String(c.issuer?.O || "").includes("Fortinet"),
          });
        }
      );
      socket.on("error", (e) => {
        if (useBind && /EINVAL/i.test(e.message)) tryConnect(false);
        else
          resolve({
            ok: false,
            error: String(e.message || e).slice(0, 200),
            bind: useBind ? localAddress : null,
          });
      });
    };
    tryConnect(true);
  });
}

async function main() {
  process.env.NIO_NETWORK = "mainnet";
  process.env.NEAR_NETWORK = "mainnet";
  const at = new Date().toISOString();
  const tlsInfo = await probeTlsHost("1click.chaindefuser.com");

  let onchainSlippage = null;
  try {
    const rpc = await pickRpc(MAINNET.near.rpcs);
    const limits = await viewFunction(
      rpc,
      MAINNET_IDENTITIES.policy,
      "get_limits",
      {}
    );
    onchainSlippage = Number(limits?.max_slippage_bps);
  } catch (e) {
    onchainSlippage = { error: String(e.message || e).slice(0, 200) };
  }
  const maxSlippageBps =
    typeof onchainSlippage === "number" && onchainSlippage > 0
      ? onchainSlippage
      : 100;

  // --- LIVE DRY (authentic body) ---
  const dryUsdc = await productionDryQuote({
    originAsset: ASSETS.eth_usdc.asset_id,
    destinationAsset: ASSETS.arb_usdc.asset_id,
    amount: "1000000",
    refundTo: MPC_EVM,
    recipient: MPC_EVM,
  });
  const dryNear = await productionDryQuote({
    originAsset: ASSETS.eth_usdc.asset_id,
    destinationAsset: ASSETS.wrap_near.asset_id,
    amount: "1000000",
    refundTo: MPC_EVM,
    recipient: OWNER_NEAR,
  });

  // --- LIVE NON-DRY (no deposit / no broadcast) ---
  // Explicit env gate required by intents.mjs
  const prevFunded = process.env.NIO_MAINNET_ALLOW_FUNDED_QUOTE;
  process.env.NIO_MAINNET_ALLOW_FUNDED_QUOTE = "1";
  let nondryUsdc = null;
  try {
    nondryUsdc = await productionDryQuote(
      {
        originAsset: ASSETS.eth_usdc.asset_id,
        destinationAsset: ASSETS.arb_usdc.asset_id,
        amount: "1000000",
        refundTo: MPC_EVM,
        recipient: MPC_EVM,
      },
      { allowFundedQuote: true }
    );
  } finally {
    if (prevFunded === undefined) delete process.env.NIO_MAINNET_ALLOW_FUNDED_QUOTE;
    else process.env.NIO_MAINNET_ALLOW_FUNDED_QUOTE = prevFunded;
  }

  const liveMinPolicy = dryUsdc.ok
    ? evaluateLiveMinOutAgainstPolicy({
        amountIn: dryUsdc.amount_in || "1000000",
        minAmountOut: dryUsdc.min_amount_out || dryUsdc.quote?.minAmountOut,
        maxSlippageBps,
        label: "live_dry_eth_usdc_to_arb_usdc",
      })
    : { result: "UNAVAILABLE", reason: dryUsdc.reason };

  // Live authorization attempt WITHOUT altering minOut — expect BLOCKED if below floor
  const liveAuthAttempt = {
    label: "live_values_unaltered",
    altered_values: false,
    dry_verify: dryUsdc.one_click_verify || null,
    min_out_policy: liveMinPolicy,
    authorization:
      liveMinPolicy.result === "PASS"
        ? "ELIGIBLE_FOR_LOCAL_POLICY_SIM_ONLY"
        : "BLOCKED_BY_POLICY_SLIPPAGE_FLOOR",
    note: "Do not inflate minAmountOut to force PASS",
  };

  // Fixture path (clearly labeled) — uses synthetic signed escrow quote
  const fixturePath = runLocalQuoteAuthorizationPath({
    route: {
      id: "fixture_eth_usdc_to_arb_usdc",
      source: ASSETS.eth_usdc,
      destination: ASSETS.arb_usdc,
    },
    amountIn: "1000000",
    amountOut: "997000",
    minAmountOut: "995000",
    depositAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    recipient: MPC_EVM,
    refundTo: MPC_EVM,
    mandateEpoch: MAINNET_EPOCH,
    maxSlippageBps: 50,
  });

  // Escrow authenticity from live non-dry
  const escrowProof = {
    nondry_obtained: Boolean(nondryUsdc?.ok),
    signature_verified: Boolean(nondryUsdc?.one_click_verify?.ok),
    deposit_address: nondryUsdc?.deposit_address || null,
    escrow_in_signed_hash: Boolean(
      nondryUsdc?.one_click_verify?.escrow_in_signed_hash
    ),
    deposit_broadcast: false,
    result:
      nondryUsdc?.one_click_verify?.ok &&
      nondryUsdc?.one_click_verify?.escrow_in_signed_hash &&
      nondryUsdc?.deposit_address
        ? "PASS"
        : nondryUsdc?.ok && !nondryUsdc?.one_click_verify?.ok
          ? "BLOCKED_SIGNATURE"
          : nondryUsdc?.ok && !nondryUsdc?.one_click_verify?.escrow_in_signed_hash
            ? "BLOCKED_ESCROW_NOT_IN_SIGNED_HASH"
            : nondryUsdc?.ok
              ? "BLOCKED"
              : `BLOCKED:${nondryUsdc?.reason || "nondry_failed"}`,
    note: "Attestor signature alone is never treated as 1Click escrow proof",
  };

  // Negative mutations on authentic dry response (if verified)
  const mutationResults = [];
  if (dryUsdc.one_click_response?.signature) {
    const base = dryUsdc.one_click_response;
    const muts = [
      ["amountOut", (c) => {
        c.quote.amountOut = "1";
      }],
      ["minAmountOut", (c) => {
        c.quote.minAmountOut = "1";
      }],
      ["originAsset", (c) => {
        c.quoteRequest.originAsset = ASSETS.arb_usdc.asset_id;
      }],
      ["destinationAsset", (c) => {
        c.quoteRequest.destinationAsset = ASSETS.wrap_near.asset_id;
      }],
      ["recipient", (c) => {
        c.quoteRequest.recipient = "0x0000000000000000000000000000000000000bad";
      }],
      ["refundTo", (c) => {
        c.quoteRequest.refundTo = "0x0000000000000000000000000000000000000bad";
      }],
      ["amountIn", (c) => {
        c.quote.amountIn = "999999";
      }],
    ];
    for (const [name, mut] of muts) {
      const m = mutateQuoteResponse(base, mut);
      const v = verifySignedOneClickQuote(m, { requirePinnedOfficialKey: true });
      mutationResults.push({
        field: name,
        verify_ok: v.ok,
        expect_reject: true,
        pass: v.ok === false,
      });
    }
    if (nondryUsdc?.one_click_response?.quote?.depositAddress) {
      const nd = nondryUsdc.one_click_response;
      for (const [name, mut] of [
        ["depositAddress", (c) => {
          c.quote.depositAddress =
            "0x0000000000000000000000000000000000000bad";
        }],
        ["deadline", (c) => {
          c.quote.deadline = new Date(Date.now() + 999_000).toISOString();
        }],
      ]) {
        const m = mutateQuoteResponse(nd, mut);
        const v = verifySignedOneClickQuote(m, { requirePinnedOfficialKey: true });
        mutationResults.push({
          field: `nondry_${name}`,
          verify_ok: v.ok,
          expect_reject: true,
          pass: v.ok === false,
        });
      }
    }
  }

  const evidence = {
    checkpoint: "J5.1",
    at,
    node: process.version,
    sdk: {
      package: "@defuse-protocol/one-click-sdk-typescript",
      installed: sdkPkg.version,
      coverage: SDK_SIGNATURE_COVERAGE,
      pinned_manager_key: ONE_CLICK_MANAGER_PUB_KEY,
    },
    safety: {
      mainnet_mutations: false,
      ledger_tx: false,
      trusted_signer_registered: false,
      funding: false,
      unpause: false,
      funded_broadcast: false,
      deposit_sent: false,
      autonomous: false,
      tls_bypass: false,
      mandate_epoch_expected: MAINNET_EPOCH,
      mpc_evm: MPC_EVM,
    },
    tls: tlsInfo,
    onchain_max_slippage_bps: onchainSlippage,
    live_dry_quote_signature_verification: {
      eth_usdc_to_arb_usdc: summarizeLive(dryUsdc),
      eth_usdc_to_wrap_near: summarizeLive(dryNear),
      verdict: dryUsdc.one_click_verify?.ok
        ? "PASS"
        : `FAIL:${dryUsdc.one_click_verify?.reason || dryUsdc.reason}`,
    },
    live_nondry_quote_signature_verification: {
      eth_usdc_to_arb_usdc: summarizeLive(nondryUsdc),
      verdict: nondryUsdc?.one_click_verify?.ok
        ? "PASS"
        : `FAIL:${nondryUsdc?.one_click_verify?.reason || nondryUsdc?.reason}`,
      deposit_broadcast: false,
    },
    sdk_signature_field_coverage: SDK_SIGNATURE_COVERAGE,
    escrow_authenticity: escrowProof,
    live_usdc_usdc_min_out_policy: liveMinPolicy,
    live_vs_fixture: {
      live_authorization: liveAuthAttempt,
      fixture_authorization: {
        label: "fixture_synthetic_signed",
        result: fixturePath.ok ? "PASS" : "FAIL",
        note: "FIXTURE ONLY — not a live quote PASS",
        altered_values: false,
        path_ok: fixturePath.ok,
      },
    },
    mutation_negatives: {
      all_rejected: mutationResults.every((r) => r.pass),
      results: mutationResults,
    },
    decimals_risk: buildDecimalsRiskReport(),
    attestor_design: attestorDesignSummary(),
    blockers_before_tiny_funded_trade: [
      liveMinPolicy.result === "PASS"
        ? null
        : "Live USDC→USDC minAmountOut below deployed policy floor — do not inflate",
      escrowProof.result === "PASS"
        ? null
        : "Escrow authenticity not PASS on live non-dry signed hash",
      "set_trusted_quote_signer not called (attestor unregistered)",
      "MPC EVM unfunded (gas + USDC)",
      "Policy paused; funded_trading/broadcast/autonomous OFF",
      "NEAR-origin NEP-141 path unproven",
    ].filter(Boolean),
  };

  const jsonPath = join(OUT, "MAINNET_CHECKPOINT_J5.json");
  writeFileSync(jsonPath, JSON.stringify(evidence, null, 2));
  const md = renderMd(evidence);
  writeFileSync(join(OUT, "MAINNET_CHECKPOINT_J5.md"), md);
  console.log("wrote", jsonPath);
  console.log(
    JSON.stringify(
      {
        dry_verify: evidence.live_dry_quote_signature_verification.verdict,
        nondry_verify: evidence.live_nondry_quote_signature_verification.verdict,
        escrow: escrowProof.result,
        live_min_out_policy: liveMinPolicy.result,
        fixture_auth: fixturePath.ok ? "PASS" : "FAIL",
        mutations_ok: evidence.mutation_negatives.all_rejected,
        sdk: sdkPkg.version,
      },
      null,
      2
    )
  );
}

function summarizeLive(q) {
  if (!q) return { ok: false, reason: "missing" };
  return {
    ok: Boolean(q.ok),
    dry: q.dry,
    reason: q.reason || null,
    signature_present: Boolean(q.signature || q.one_click_response?.signature),
    timestamp: q.timestamp || q.one_click_response?.timestamp || null,
    correlation_id: q.correlation_id || null,
    amount_in: q.amount_in || null,
    amount_out: q.amount_out || null,
    min_amount_out: q.min_amount_out || q.quote?.minAmountOut || null,
    deposit_address: q.deposit_address,
    verify: q.one_click_verify || null,
    status_label: q.status_label || null,
    authenticated_jwt: Boolean(q.authenticated),
    tls: q.tls || null,
    values_altered: false,
  };
}

function renderMd(e) {
  return `# Checkpoint J5.1 — Live quote verification + evidence correction

**Broadcast / Ledger / unpause / funding / deposit / attestor register:** NONE  
**SDK:** \`@defuse-protocol/one-click-sdk-typescript@${e.sdk.installed}\`  
**Evidence JSON:** \`MAINNET_CHECKPOINT_J5.json\`

## 1. Real dry quote signature verification

**${e.live_dry_quote_signature_verification.verdict}**

Authentic \`OneClickQuoteResponse\` preserved (\`quoteRequest\`, \`quote\`, \`signature\`, \`timestamp\`, \`correlationId\`). Verified with pinned manager key \`${e.sdk.pinned_manager_key}\` before normalization.

## 2. Real non-dry signature verification

**${e.live_nondry_quote_signature_verification.verdict}** (no deposit sent)

## 3. SDK signature field coverage (${e.sdk.installed})

- Dry: amounts only
- Non-dry: amounts + \`depositAddress\`, \`depositMemo\`, \`deadline\`, \`timeWhenInactive\`, \`timeEstimate\`, fees
- Request: assets, amount, recipient, refundTo, dry, …

(0.1.24 omitted escrow from hash; docs require >=0.1.26.)

## 4. Escrow authenticity

**${e.escrow_authenticity.result}** — attestor signature alone is never treated as 1Click escrow proof.

## 5. Live USDC→USDC min-out vs deployed policy

On-chain \`max_slippage_bps\`: **${e.onchain_max_slippage_bps}**  
Live result: **${e.live_usdc_usdc_min_out_policy.result}** (values unaltered)

| Kind | Result |
|------|--------|
| Live authorization | ${e.live_vs_fixture.live_authorization.authorization} |
| Fixture authorization | ${e.live_vs_fixture.fixture_authorization.result} (FIXTURE ONLY) |

## 6. Next readiness

Do not proceed to funded trading until live quote, escrow signed-hash coverage, attestor (\`set_trusted_quote_signer\`), and policy floor all PASS without altered values.
`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
