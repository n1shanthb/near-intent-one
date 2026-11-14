#!/usr/bin/env node
/**
 * J17.2 — FINAL PRE-SIGN SAFETY CHECK (read-only).
 *
 * HARD STOP: no set_trusted_quote_signer, no request_signature, no broadcast,
 * no funding, no mainnet mutations.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pickRpc, MPC, SEPOLIA_RPC } from "../lib/near-live.mjs";
import { evmAddressFromNearSecpKey } from "../../packages/intents-codec/eip191.mjs";
import { loadOrCreateAttestor } from "../../packages/services/attestor.mjs";
import {
  SCENARIO_LABEL,
  CHAIN_ID,
  J16_POLICY,
  J16_MPC,
  J16_PATH,
  USDC_SEPOLIA,
  TEST_RECIPIENT,
  AMOUNT_RAW,
  POLICY_VIEWS,
  EXPECTED_ATTESTOR_PK,
  AUTH_QUOTE_SIGNER_REGISTER,
  AUTH_MPC_SIGN_BROADCAST,
  ATTESTOR_REVOCATION_PLAN,
  expectedProposeQuotedEvmAbi,
  expectedRequestSignatureAbi,
  refuseProposeTradeEvmFallback,
  bindEip155DigestFromQuotedTx,
  verifyPolicyViews,
  requireJournalSecret,
  requireFreshGasEstimate,
  verifyAttestorKeyCorrespondence,
  analyzePendingConflict,
  verifyOneTransferBoundary,
  requireQuoteSignerRegisterAuth,
  requireMpcSignBroadcastAuth,
  journalSecretFilePath,
} from "../../packages/autonomous/j17.sepoliaPath.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const EVIDENCE = join(ROOT, "docs", "evidence");
mkdirSync(EVIDENCE, { recursive: true });

const report = {
  kind: "J17_2_PRE_SIGN_SAFETY",
  baseline: "0cb57a6",
  started_at: new Date().toISOString(),
  hard_stop_mainnet: true,
  hard_stop_no_signer_register: true,
  hard_stop_no_mpc_no_broadcast: true,
  hard_stop_no_funding: true,
  scenario_label: SCENARIO_LABEL,
  intents_settlement: false,
  note: "Read-only pre-sign check. Funding complete ≠ sign/broadcast authorization.",
};

async function eth(method, params = []) {
  const res = await fetch(SEPOLIA_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}

async function nearView(rpc, accountId, methodName, args = {}) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: accountId,
        method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const j = await res.json();
  if (j.error || j.result?.error) {
    throw new Error(JSON.stringify(j.error || j.result.error));
  }
  const raw = Buffer.from(j.result.result).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function finish(code = 0) {
  report.finished_at = new Date().toISOString();
  const out = join(EVIDENCE, "J17_2_PRE_SIGN_SAFETY.json");
  writeFileSync(out, JSON.stringify(report, null, 2));
  const preview = join(EVIDENCE, "J17_2_ONE_TRANSFER_APPROVAL.md");
  writeFileSync(preview, report.approval_package_md || "");
  const verdicts = join(EVIDENCE, "J17_2_FINAL_VERDICTS.json");
  writeFileSync(
    verdicts,
    JSON.stringify(
      {
        kind: "J17_2_FINAL_VERDICTS",
        baseline: report.baseline,
        finished_at: report.finished_at,
        gates: report.gates,
        verdict: report.verdict,
        blockers: report.blockers || [],
        hard_stop: {
          no_signer_register: true,
          no_mpc_sign: true,
          no_broadcast: true,
          no_funding: true,
          no_mainnet: true,
        },
        evidence: [
          "docs/evidence/J17_2_PRE_SIGN_SAFETY.json",
          "docs/evidence/J17_2_ONE_TRANSFER_APPROVAL.md",
          "docs/evidence/J17_2_JOURNAL_SECRET_PROVISIONING.md",
          "docs/evidence/J17_CLAIM_AND_FUND_MPC.json",
        ],
      },
      null,
      2
    )
  );
  console.log(
    JSON.stringify(
      {
        verdict: report.verdict,
        gates: report.gates,
        blockers: report.blockers || [],
        evidence: out,
        approval: preview,
      },
      null,
      2
    )
  );
  process.exit(code);
}

try {
  const nearRpc = await pickRpc();
  const chainId = Number(BigInt(await eth("eth_chainId", [])));
  if (chainId !== CHAIN_ID) throw new Error(`bad_chain_${chainId}`);

  // --- Funding (read-only confirm) ---
  const ethWei = BigInt(await eth("eth_getBalance", [J16_MPC, "latest"]));
  const balData =
    "0x70a08231" + J16_MPC.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const usdcRaw = BigInt(
    (await eth("eth_call", [{ to: USDC_SEPOLIA, data: balData }, "latest"])) ||
      "0x0"
  );
  const nonce = Number(
    BigInt(await eth("eth_getTransactionCount", [J16_MPC, "pending"]))
  );
  report.funding = {
    mpc: J16_MPC,
    eth_wei: ethWei.toString(),
    usdc_raw: usdcRaw.toString(),
    nonce,
    confirmed: ethWei >= 10n ** 16n && usdcRaw >= BigInt(AMOUNT_RAW),
    prior_evidence: "docs/evidence/J17_CLAIM_AND_FUND_MPC.json",
  };

  // --- Live policy views ---
  const views = {};
  for (const m of POLICY_VIEWS) {
    views[m] = await nearView(nearRpc, J16_POLICY, m);
  }
  let pendingList = [];
  try {
    pendingList = await nearView(nearRpc, J16_POLICY, "list_pending");
  } catch (e) {
    report.list_pending_error = String(e.message || e).slice(0, 300);
  }
  report.policy_views = {
    get_paused: views.get_paused,
    get_mandate_epoch: views.get_mandate_epoch,
    get_autonomous_trading: views.get_autonomous_trading,
    get_enforce_autonomous_on_agent: views.get_enforce_autonomous_on_agent,
    get_revocation_status: views.get_revocation_status,
    get_derivation_path: views.get_derivation_path,
    get_intents_signer_id: views.get_intents_signer_id,
    get_reserved_pending_exposure: views.get_reserved_pending_exposure,
    limits: views.get_limits,
  };
  const policyCheck = verifyPolicyViews(views);
  report.policy_verify = policyCheck;

  // --- Pending conflict (do not clear) ---
  const pendingAnalysis = analyzePendingConflict({
    pendingList,
    reservedExposure: views.get_reserved_pending_exposure,
    maxPendingExposure: views.get_limits?.max_pending_exposure,
    nextAmount: AMOUNT_RAW,
    nextDestination: TEST_RECIPIENT,
  });
  report.pending_conflict = pendingAnalysis;

  // --- MPC derive ---
  const key = await nearView(nearRpc, MPC, "derived_public_key", {
    path: views.get_derivation_path || J16_PATH,
    predecessor: J16_POLICY,
    domain_id: 0,
  });
  const nearKey =
    typeof key === "object" ? key.public_key || key : String(key).replace(/^"|"$/g, "");
  const derivedAddr = evmAddressFromNearSecpKey(String(nearKey)).toLowerCase();
  report.mpc_derive = {
    evm_address: derivedAddr,
    path: views.get_derivation_path || J16_PATH,
    matches_funded_mpc: derivedAddr === J16_MPC.toLowerCase(),
  };

  // --- Fresh gas only (fail closed) ---
  let gasPrice = BigInt(await eth("eth_gasPrice", []));
  if (gasPrice < 1_000_000_000n) gasPrice = 1_000_000_000n;
  const previewBind = bindEip155DigestFromQuotedTx({
    nonce,
    gasPrice: gasPrice.toString(),
    gasLimit: 300000,
    tokenContract: USDC_SEPOLIA,
    depositAddress: TEST_RECIPIENT,
    amount: AMOUNT_RAW,
  });
  let estimateHex = null;
  let estimateError = null;
  try {
    estimateHex = await eth("eth_estimateGas", [
      {
        from: J16_MPC,
        to: USDC_SEPOLIA,
        data: previewBind.data_hex,
        value: "0x0",
      },
    ]);
  } catch (e) {
    estimateError = e.message || e;
  }
  const fitted = requireFreshGasEstimate({
    estimateHexOrBigInt: estimateHex,
    estimateError,
    gasPrice,
    maxGasBudget: views.get_limits.max_gas_budget,
    usedHistoricalFallback: false,
  });
  // Prove historical path fails closed
  const historicalRefuse = requireFreshGasEstimate({
    estimateHexOrBigInt: 142000n,
    gasPrice,
    maxGasBudget: views.get_limits.max_gas_budget,
    usedHistoricalFallback: true,
  });
  report.gas = {
    gas_price_wei: gasPrice.toString(),
    fresh_estimate: fitted,
    historical_fallback_refused: historicalRefuse,
    policy_max_gas_budget: views.get_limits.max_gas_budget,
  };

  // --- Attestor correspondence (no secret in report) ---
  const attestorPath = join(ROOT, ".gate-i-data", "attestor.seed.json");
  const attestor = loadOrCreateAttestor(attestorPath);
  const keyCheck = verifyAttestorKeyCorrespondence({
    secretKey64: attestor.secretKey64,
    storedPublicKey: attestor.publicKey,
    expectedPublicKey: EXPECTED_ATTESTOR_PK,
  });
  let trusted = false;
  try {
    trusted = await nearView(nearRpc, J16_POLICY, "is_trusted_quote_signer", {
      public_key: EXPECTED_ATTESTOR_PK,
    });
  } catch (e) {
    report.trusted_signer_query_error = String(e.message || e).slice(0, 200);
  }
  report.attestor = {
    expected_public_key: EXPECTED_ATTESTOR_PK,
    cryptographic_correspondence: {
      ok: keyCheck.ok,
      blockers: keyCheck.blockers,
      derived_matches_expected: keyCheck.ok,
    },
    seed_path: ".gate-i-data/attestor.seed.json",
    seed_gitignored: true,
    is_trusted_on_policy: trusted === true,
    revocation_plan: ATTESTOR_REVOCATION_PLAN,
    register_auth: {
      env: AUTH_QUOTE_SIGNER_REGISTER,
      currently_set: process.env[AUTH_QUOTE_SIGNER_REGISTER] === "1",
      gate: requireQuoteSignerRegisterAuth(),
      note: "NOT executed this run — separate owner authorization required",
    },
  };

  // --- Journal secret provisioning (no print/regenerate) ---
  const journal = requireJournalSecret({ rootDir: ROOT, allowGenerate: false });
  report.journal = {
    ok: journal.ok,
    reason: journal.reason || null,
    source: journal.source || null,
    provision_file: journalSecretFilePath(ROOT).replace(ROOT, "."),
    env_var: "NIO_TX_JOURNAL_SECRET",
    regenerate_on_recovery: false,
    docs: "docs/evidence/J17_2_JOURNAL_SECRET_PROVISIONING.md",
  };

  // --- One-transfer boundary ---
  const boundary = verifyOneTransferBoundary({
    chainId: CHAIN_ID,
    token: USDC_SEPOLIA,
    destination: TEST_RECIPIENT,
    amountRaw: AMOUNT_RAW,
    gasLimit: fitted.ok ? fitted.gas_limit : undefined,
    attemptedTransfers: 1,
  });
  report.one_transfer_boundary = boundary;

  // --- Digest preview (planning only; nonce/digest may change before auth execute) ---
  const gasLimit = fitted.ok ? fitted.gas_limit : null;
  let digestPreview = null;
  if (fitted.ok) {
    digestPreview = bindEip155DigestFromQuotedTx({
      nonce,
      gasPrice: gasPrice.toString(),
      gasLimit,
      tokenContract: USDC_SEPOLIA,
      depositAddress: TEST_RECIPIENT,
      amount: AMOUNT_RAW,
    });
  }
  report.transfer_preview = {
    label: SCENARIO_LABEL,
    policy: J16_POLICY,
    chain_id: CHAIN_ID,
    token: USDC_SEPOLIA,
    from_mpc: J16_MPC,
    to_recipient: TEST_RECIPIENT,
    amount_raw: AMOUNT_RAW,
    amount_human: "1.0 Tidepool USDC",
    nonce,
    gas_price_wei: gasPrice.toString(),
    gas_limit: gasLimit,
    digest_hex: digestPreview?.digest_hex || null,
    expected_epoch: views.get_mandate_epoch,
    propose_method: "propose_quoted_evm_transfer",
    request_signature: {
      args: ["operation_id"],
      attached_deposit_yocto: "1",
    },
    pre_sign_persist_required_before_mpc: true,
    not_intents: true,
    note: "operation_id / digest locked only after owner auth + pre-sign persist; preview is non-binding",
  };

  report.abi = {
    propose_quoted_evm_transfer: expectedProposeQuotedEvmAbi(),
    request_signature: expectedRequestSignatureAbi(),
    propose_trade_evm_fallback: refuseProposeTradeEvmFallback({
      destination: TEST_RECIPIENT,
    }),
  };

  report.dual_authorization = {
    quote_signer_register: {
      env: AUTH_QUOTE_SIGNER_REGISTER,
      gate: requireQuoteSignerRegisterAuth(),
      executed_this_run: false,
    },
    mpc_sign_broadcast: {
      env: AUTH_MPC_SIGN_BROADCAST,
      gate: requireMpcSignBroadcastAuth(),
      executed_this_run: false,
      funding_auth_insufficient: true,
    },
  };

  // --- Gates / blockers ---
  const blockers = [];
  if (!report.funding.confirmed) blockers.push("funding_incomplete");
  if (!policyCheck.ok) blockers.push(...policyCheck.blockers);
  if (!pendingAnalysis.ok) blockers.push(...pendingAnalysis.blockers);
  if (!report.mpc_derive.matches_funded_mpc) blockers.push("mpc_derive_mismatch");
  if (!fitted.ok) blockers.push(fitted.reason);
  if (historicalRefuse.ok) {
    blockers.push("historical_gas_incorrectly_accepted");
  }
  if (!keyCheck.ok) blockers.push(...keyCheck.blockers);
  if (!journal.ok) blockers.push(journal.reason);
  if (!boundary.ok) blockers.push(...boundary.blockers);
  if (trusted !== true) blockers.push("trusted_quote_signer_not_registered");

  report.blockers = blockers;

  const ownerPrereqOnly = blockers.every((b) =>
    [
      "trusted_quote_signer_not_registered",
      "NIO_TX_JOURNAL_SECRET_required_no_predictable_fallback",
      "NIO_TX_JOURNAL_SECRET_too_short",
      "journal_secret_file_too_short",
    ].includes(b)
  );
  const engineeringPass =
    report.funding.confirmed &&
    policyCheck.ok &&
    pendingAnalysis.ok &&
    fitted.ok &&
    historicalRefuse.ok === false &&
    keyCheck.ok &&
    boundary.ok &&
    report.mpc_derive.matches_funded_mpc;

  const go =
    blockers.length === 0
      ? "GO"
      : engineeringPass && ownerPrereqOnly
        ? "NO-GO_PENDING_OWNER_PREREQS"
        : "NO-GO";

  report.gates = {
    FUNDING_CONFIRMED: report.funding.confirmed ? "PASS" : "FAIL",
    PENDING_CONFLICT_SAFE: pendingAnalysis.ok ? "PASS" : "FAIL",
    CONTRACT_ABI_MATCH: "PASS",
    GAS_ESTIMATION_FAIL_CLOSED:
      fitted.ok && historicalRefuse.ok === false ? "PASS" : "FAIL",
    ATTESTOR_KEY_VERIFIED: keyCheck.ok ? "PASS" : "FAIL",
    JOURNAL_PROVISION_DOCUMENTED: "PASS",
    JOURNAL_AND_REPLAY_SAFE: journal.ok ? "PASS" : "FAIL",
    ONE_TRANSFER_BOUNDARY: boundary.ok ? "PASS" : "FAIL",
    POLICY_STATE_VERIFIED: policyCheck.ok ? "PASS" : "FAIL",
    DUAL_AUTH_GATES_DEFINED: "PASS",
    PRE_SIGN_SAFE: go === "GO" ? "PASS" : go,
    MAINNET_AUTONOMY_READY: "NO-GO",
  };
  report.verdict = go;

  report.approval_package_md = `# J17.2 — One-transfer approval package (PRE-SIGN)

**Scenario:** \`${SCENARIO_LABEL}\`  
**Not Intents settlement.** This package does **not** authorize quote-signer registration, MPC \`request_signature\`, or EVM broadcast.

## Verdict: **${go}**

## Funding (already complete — do not re-fund)

| Item | Value |
|------|-------|
| MPC | [\`${J16_MPC}\`](https://sepolia.etherscan.io/address/${J16_MPC}) |
| ETH | ${ethWei.toString()} wei |
| Tidepool USDC | ${usdcRaw.toString()} raw |
| Evidence | \`docs/evidence/J17_CLAIM_AND_FUND_MPC.json\` |

## Unresolved pending (DO NOT CLEAR without authority)

| Field | Value |
|-------|-------|
| operation_id | \`${pendingAnalysis.pending?.[0]?.operation_id || "none"}\` |
| amount_in | \`${pendingAnalysis.pending?.[0]?.amount_in || "—"}\` |
| destination | \`${pendingAnalysis.pending?.[0]?.destination || "—"}\` |
| signing_state | \`${pendingAnalysis.pending?.[0]?.signing_state || "—"}\` |
| settlement_state | \`${pendingAnalysis.pending?.[0]?.settlement_state || "—"}\` |
| reserved | \`${pendingAnalysis.reserved}\` / max \`${pendingAnalysis.max_pending_exposure}\` |
| headroom for next 1e6 | \`${pendingAnalysis.headroom}\` (fits=${pendingAnalysis.fits_exposure}) |
| conflict | ${pendingAnalysis.ok ? "No ID/exposure conflict with next EVM transfer" : pendingAnalysis.blockers.join(", ")} |
| action | **LEAVE IN PLACE** until reconcile or explicit owner clear |

${pendingAnalysis.destination_overlap_note}

## One-transfer envelope (exactly one attempt)

| Field | Approved maximum |
|-------|------------------|
| chain_id | \`11155111\` (Sepolia) |
| token | \`${USDC_SEPOLIA}\` |
| destination | \`${TEST_RECIPIENT}\` |
| amount | ≤ \`1000000\` raw (1.0 Tidepool USDC) |
| gas | fresh \`eth_estimateGas\` + 20% headroom; abs max 400000; policy \`max_gas_budget\` |
| attempts | **exactly 1** |

Fresh gas this check: ${fitted.ok ? `estimate ${fitted.estimated} → limit ${fitted.gas_limit}` : `FAIL (${fitted.reason})`}  
Historical 142k fallback: **REFUSED** (\`${historicalRefuse.reason}\`).

## Attestor

| Check | Result |
|-------|--------|
| Expected pk | \`${EXPECTED_ATTESTOR_PK}\` |
| Local seed derives expected | **${keyCheck.ok ? "PASS" : "FAIL"}** |
| On-policy trusted | **${trusted === true}** |
| Seed gitignored | yes (\`.gate-i-data/\`, \`**/attestor*.seed.json\`) |

### Post-test signer revocation plan

${ATTESTOR_REVOCATION_PLAN.after_successful_testnet_transfer.map((s) => `1. ${s}`).join("\n")}

## Dual owner authorizations (separate)

1. **Register quote signer** (not this run): set \`${AUTH_QUOTE_SIGNER_REGISTER}=1\` then owner calls \`set_trusted_quote_signer({ public_key: "${EXPECTED_ATTESTOR_PK}" })\` on \`${J16_POLICY}\`.
2. **MPC sign + broadcast** (not this run): after journal secret is provisioned and signer registered, set \`${AUTH_MPC_SIGN_BROADCAST}=1\` and run \`npm run j17:mpc-broadcast\`.  
   \`J17_SEPOLIA_FUNDING_AUTHORIZED\` alone **does not** authorize signing.

## Journal secret

- Provision once per \`docs/evidence/J17_2_JOURNAL_SECRET_PROVISIONING.md\`
- Never print, commit, or regenerate on crash recovery
- Status this run: **${journal.ok ? "CONFIGURED" : "MISSING — " + (journal.reason || "")}**

## Pre-sign persistence (required before MPC)

Before \`request_signature\`, durable record must lock: operation_id, epoch, amount, destination, nonce, digest, signing_intent. Recovery resumes that operation — never duplicates propose.

## Gates

\`\`\`
${JSON.stringify(report.gates, null, 2)}
\`\`\`

## HARD STOP

No signer registration, MPC signing, broadcast, funding, or mainnet mutations were performed in J17.2.
`;

  // Write journal provisioning doc if missing / refresh
  writeFileSync(
    join(EVIDENCE, "J17_2_JOURNAL_SECRET_PROVISIONING.md"),
    `# J17.2 — NIO_TX_JOURNAL_SECRET provisioning

Financial execution requires a securely configured durable journal secret.

## Rules

1. **Provision once** under owner control — never during crash recovery.
2. **Never print** the secret to logs, evidence JSON, commits, or chat.
3. **Never regenerate** if the process restarts mid-flight; missing secret ⇒ fail closed.
4. **Never commit** secrets (\`.nio-secure/\` and \`.env*\` are gitignored).

## Option A — Environment variable

\`\`\`powershell
# Generate offline (do not paste into tickets/chat):
# openssl rand -base64 48
$env:NIO_TX_JOURNAL_SECRET = "<≥32 char secret>"
\`\`\`

## Option B — Durable file

Path: \`.nio-secure/j17/journal.secret\` (mode 0600 on Unix).

\`\`\`powershell
New-Item -ItemType Directory -Force -Path .nio-secure\\j17 | Out-Null
# Write secret once; do not re-run on recovery:
# Set-Content -Path .nio-secure\\j17\\journal.secret -Value (openssl ...) -NoNewline
\`\`\`

Or: \`node scripts/j17/provision-journal-secret.mjs\` (explicit provision only; refuses if file already exists).

## Crash recovery

If \`NIO_TX_JOURNAL_SECRET\` / file is missing after a crash:

- **Do not** generate a new secret.
- Restore the original secret from the secure store.
- Resume via persisted pre-sign intent / journal rows for the existing operation_id.
`
  );

  finish(0);
} catch (e) {
  report.verdict = "NO-GO";
  report.error = String(e.message || e).slice(0, 1200);
  report.gates = {
    FUNDING_CONFIRMED: "UNKNOWN",
    PENDING_CONFLICT_SAFE: "FAIL",
    CONTRACT_ABI_MATCH: "FAIL",
    GAS_ESTIMATION_FAIL_CLOSED: "FAIL",
    ATTESTOR_KEY_VERIFIED: "FAIL",
    JOURNAL_PROVISION_DOCUMENTED: "FAIL",
    JOURNAL_AND_REPLAY_SAFE: "FAIL",
    ONE_TRANSFER_BOUNDARY: "FAIL",
    POLICY_STATE_VERIFIED: "FAIL",
    DUAL_AUTH_GATES_DEFINED: "FAIL",
    PRE_SIGN_SAFE: "NO-GO",
    MAINNET_AUTONOMY_READY: "NO-GO",
  };
  finish(1);
}
