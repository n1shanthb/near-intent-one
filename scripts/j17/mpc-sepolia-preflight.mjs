#!/usr/bin/env node
/**
 * J17.1 — PRE_BROADCAST_READY for funded Sepolia MPC ERC-20 path.
 *
 * Does NOT: claim faucets, set J17_SEPOLIA_FUNDING_AUTHORIZED, request_signature,
 * or eth_sendRawTransaction.
 *
 * Builds a complete one-transfer approval preview using real policy views,
 * eth_estimateGas, and a labeled deterministic attestation (NOT Intents).
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import {
  pickRpc,
  MPC,
  SEPOLIA_RPC,
} from "../lib/near-live.mjs";
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
  expectedProposeQuotedEvmAbi,
  expectedRequestSignatureAbi,
  assertProposeQuotedArgs,
  assertRequestSignatureArgs,
  refuseProposeTradeEvmFallback,
  buildDeterministicErc20Attestation,
  bindEip155DigestFromQuotedTx,
  validateQuotedTxAgainstAttestation,
  requireFreshGasEstimate,
  verifyPolicyViews,
  requireJournalSecret,
} from "../../packages/autonomous/j17.sepoliaPath.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const EVIDENCE = join(ROOT, "docs", "evidence");
mkdirSync(EVIDENCE, { recursive: true });

const report = {
  kind: "J17_1_PRE_BROADCAST_READY",
  baseline: "df3a84b",
  started_at: new Date().toISOString(),
  hard_stop_mainnet: true,
  hard_stop_no_mpc_no_broadcast: true,
  scenario_label: SCENARIO_LABEL,
  intents_settlement: false,
  note: "Funding confirmed earlier; this run does not authorize MPC sign or EVM broadcast.",
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

async function deriveMpcEvm({ rpc, policyId, path }) {
  const key = await nearView(rpc, MPC, "derived_public_key", {
    path,
    predecessor: policyId,
    domain_id: 0,
  });
  const nearKey =
    typeof key === "object" ? key.public_key || key : String(key).replace(/^"|"$/g, "");
  return {
    near_secp_key: nearKey,
    evm_address: evmAddressFromNearSecpKey(String(nearKey)).toLowerCase(),
    path,
    predecessor: policyId,
  };
}

function finish(code = 0) {
  report.finished_at = new Date().toISOString();
  const out = join(EVIDENCE, "J17_1_PRE_BROADCAST_READY.json");
  writeFileSync(out, JSON.stringify(report, null, 2));
  const previewOut = join(EVIDENCE, "J17_1_ONE_TRANSFER_APPROVAL_PREVIEW.md");
  writeFileSync(previewOut, report.approval_preview_md || "");
  console.log(
    JSON.stringify(
      {
        verdict: report.verdict,
        gates: report.gates,
        blockers: report.blockers || [],
        evidence: out,
        preview: previewOut,
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

  // --- Funding confirm (read-only) ---
  const ethWei = BigInt(await eth("eth_getBalance", [J16_MPC, "latest"]));
  const balData =
    "0x70a08231" + J16_MPC.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const usdcRaw = BigInt(
    (await eth("eth_call", [{ to: USDC_SEPOLIA, data: balData }, "latest"])) || "0x0"
  );
  const nonce = Number(
    BigInt(await eth("eth_getTransactionCount", [J16_MPC, "pending"]))
  );
  report.funding = {
    mpc: J16_MPC,
    eth_wei: ethWei.toString(),
    usdc_raw: usdcRaw.toString(),
    nonce,
    explorer: `https://sepolia.etherscan.io/address/${J16_MPC}`,
    prior_evidence: "docs/evidence/J17_CLAIM_AND_FUND_MPC.json",
    confirmed: ethWei >= 10n ** 16n && usdcRaw >= BigInt(AMOUNT_RAW),
  };

  // --- Live policy views (real ABI) ---
  const views = {};
  for (const m of POLICY_VIEWS) {
    views[m] = await nearView(nearRpc, J16_POLICY, m);
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

  const derived = await deriveMpcEvm({
    rpc: nearRpc,
    policyId: J16_POLICY,
    path: views.get_derivation_path || J16_PATH,
  });
  report.mpc_derive = {
    ...derived,
    matches_funded_mpc: derived.evm_address === J16_MPC.toLowerCase(),
    matches_intents_signer:
      String(views.get_intents_signer_id || "").toLowerCase() ===
      J16_MPC.toLowerCase(),
  };

  // --- Gas estimation ---
  let gasPrice = BigInt(await eth("eth_gasPrice", []));
  if (gasPrice < 1_000_000_000n) gasPrice = 1_000_000_000n; // 1 gwei floor for inclusion
  const transferData = bindEip155DigestFromQuotedTx({
    nonce,
    gasPrice: gasPrice.toString(),
    gasLimit: 300000,
    tokenContract: USDC_SEPOLIA,
    depositAddress: TEST_RECIPIENT,
    amount: AMOUNT_RAW,
  });
  let estHex = null;
  let estimateError = null;
  try {
    estHex = await eth("eth_estimateGas", [
      {
        from: J16_MPC,
        to: USDC_SEPOLIA,
        data: transferData.data_hex,
        value: "0x0",
      },
    ]);
  } catch (e) {
    estimateError = String(e.message || e).slice(0, 300);
  }
  const limits = views.get_limits;
  const fitted = requireFreshGasEstimate({
    estimateHexOrBigInt: estHex,
    estimateError,
    gasPrice,
    maxGasBudget: limits.max_gas_budget,
    usedHistoricalFallback: false,
  });
  const estimated = fitted.ok ? BigInt(fitted.estimated) : 0n;
  report.gas = {
    gas_price_wei: gasPrice.toString(),
    estimate: fitted,
    policy_max_gas_budget: limits.max_gas_budget,
    historical_fallback_forbidden: true,
  };

  // Cap max_gas_price in attestation to fitted gas_price (and policy budget)
  const maxGasPrice = gasPrice; // exact fitted price ceiling for this one transfer
  if (!fitted.ok) {
    report.blockers = [...(report.blockers || []), fitted.reason];
  }

  // --- Attestor / trusted signer ---
  const attestorPath = join(ROOT, ".gate-i-data", "attestor.seed.json");
  const attestor = loadOrCreateAttestor(attestorPath);
  let trusted = false;
  try {
    trusted = await nearView(nearRpc, J16_POLICY, "is_trusted_quote_signer", {
      public_key: attestor.publicKey,
    });
  } catch (e) {
    report.trusted_signer_query_error = String(e.message || e).slice(0, 200);
  }
  report.attestor = {
    public_key: attestor.publicKey,
    is_trusted_on_policy: trusted === true,
    owner_prereq:
      trusted === true
        ? null
        : {
            method: "set_trusted_quote_signer",
            args: { public_key: attestor.publicKey },
            actor: "nio-owner-02b7cf.testnet",
            note: "Required before propose_quoted_evm_transfer; not executed in this preflight",
          },
  };

  // --- Deterministic attestation + digest binding ---
  const gasLimit = fitted.ok ? fitted.gas_limit : "170000";
  const built = buildDeterministicErc20Attestation({
    secretKey64: attestor.secretKey64,
    depositAddress: TEST_RECIPIENT,
    tokenContract: USDC_SEPOLIA,
    amountIn: AMOUNT_RAW,
    recipient: TEST_RECIPIENT,
    refundTo: TEST_RECIPIENT,
    maxGasPrice: maxGasPrice.toString(),
    gasLimit,
  });
  if (!built.ok) throw new Error(built.reason);

  const opId = `j17-1-${randomBytes(3).toString("hex")}`;
  const tx = {
    nonce: String(nonce),
    gas_price: gasPrice.toString(),
    gas_limit: gasLimit,
    chain_id: String(CHAIN_ID),
    token_contract: USDC_SEPOLIA.toLowerCase(),
    to: TEST_RECIPIENT.toLowerCase(),
    amount: AMOUNT_RAW,
  };
  const bind = bindEip155DigestFromQuotedTx({
    nonce,
    gasPrice: tx.gas_price,
    gasLimit: tx.gas_limit,
    tokenContract: tx.token_contract,
    depositAddress: tx.to,
    amount: tx.amount,
  });
  const txAttest = validateQuotedTxAgainstAttestation({
    attestation: built.attestation,
    tx,
  });

  const proposeArgs = {
    operation_id: opId,
    attestation: built.attestation,
    attestation_signature: built.attestation_signature,
    signer_public_key: built.signer_public_key,
    tx,
    expected_epoch: views.get_mandate_epoch,
  };
  const proposeAbiCheck = assertProposeQuotedArgs(proposeArgs);
  const requestArgs = { operation_id: opId };
  const requestAbiCheck = assertRequestSignatureArgs(requestArgs);
  const refuseTrade = refuseProposeTradeEvmFallback({
    destination: TEST_RECIPIENT,
  });

  report.abi = {
    propose_quoted_evm_transfer: expectedProposeQuotedEvmAbi(),
    request_signature: expectedRequestSignatureAbi(),
    propose_args_valid: proposeAbiCheck,
    request_args_valid: requestAbiCheck,
    propose_trade_evm_fallback: refuseTrade,
  };

  report.digest_binding = {
    ok: txAttest.ok && bind.digest_hex?.length === 64,
    tx_vs_attestation: txAttest,
    digest_hex: bind.digest_hex,
    eip155_to: bind.eip155_to,
    transfer_to: bind.transfer_to,
    amount: bind.amount,
  };

  // Journal secret — no predictable fallback
  const journal = requireJournalSecret();
  report.journal = journal;

  // Exposure headroom
  const reserved = BigInt(
    views.get_reserved_pending_exposure?.toString?.() ||
      views.get_reserved_pending_exposure ||
      0
  );
  const maxPend = BigInt(limits.max_pending_exposure);
  const headroom = maxPend - reserved;
  report.exposure = {
    reserved: reserved.toString(),
    max_pending_exposure: maxPend.toString(),
    headroom: headroom.toString(),
    next_amount: AMOUNT_RAW,
    fits: headroom >= BigInt(AMOUNT_RAW),
  };

  report.transfer_preview = {
    label: SCENARIO_LABEL,
    policy: J16_POLICY,
    agent: views.get_agent,
    operation_id: opId,
    chain_id: CHAIN_ID,
    token: USDC_SEPOLIA.toLowerCase(),
    from_mpc: J16_MPC,
    to_recipient: TEST_RECIPIENT.toLowerCase(),
    amount_raw: AMOUNT_RAW,
    amount_human: "1.0 Tidepool USDC",
    nonce,
    gas_price_wei: gasPrice.toString(),
    gas_limit: gasLimit,
    digest_hex: bind.digest_hex,
    derivation_path: views.get_derivation_path || J16_PATH,
    expected_epoch: views.get_mandate_epoch,
    propose_method: "propose_quoted_evm_transfer",
    request_signature: {
      args: requestArgs,
      attached_deposit_yocto: "1",
    },
    not_intents: true,
  };

  // Gates
  const blockers = [];
  if (!report.funding.confirmed) blockers.push("funding_incomplete");
  if (!policyCheck.ok) blockers.push(...policyCheck.blockers);
  if (!report.mpc_derive.matches_funded_mpc) blockers.push("mpc_derive_mismatch");
  if (!fitted.ok) blockers.push(fitted.reason);
  if (!proposeAbiCheck.ok) blockers.push(proposeAbiCheck.reason);
  if (!requestAbiCheck.ok) blockers.push(requestAbiCheck.reason);
  if (!txAttest.ok) blockers.push(...txAttest.blockers);
  if (!refuseTrade.ok === false && refuseTrade.action === "REFUSE") {
    /* expected */
  }
  if (!journal.ok) blockers.push(journal.reason);
  if (!report.exposure.fits) blockers.push("pending_exposure_headroom");
  if (trusted !== true) blockers.push("trusted_quote_signer_not_registered");

  report.blockers = blockers;
  const ownerPrereqOnly = blockers.every((b) =>
    [
      "trusted_quote_signer_not_registered",
      "NIO_TX_JOURNAL_SECRET_required_no_predictable_fallback",
    ].includes(b)
  );
  const engineeringPass =
    report.funding.confirmed &&
    proposeAbiCheck.ok &&
    requestAbiCheck.ok &&
    refuseTrade.action === "REFUSE" &&
    report.digest_binding.ok &&
    fitted.ok &&
    policyCheck.ok;

  report.gates = {
    FUNDING_CONFIRMED: report.funding.confirmed ? "PASS" : "FAIL",
    CONTRACT_ABI_MATCH:
      proposeAbiCheck.ok && requestAbiCheck.ok && refuseTrade.action === "REFUSE"
        ? "PASS"
        : "FAIL",
    SIGNATURE_DEPOSIT_CORRECT: requestAbiCheck.ok ? "PASS" : "FAIL",
    DIGEST_BINDING_VALID: report.digest_binding.ok ? "PASS" : "FAIL",
    GAS_ESTIMATION_VALID: fitted.ok ? "PASS" : "FAIL",
    POLICY_STATE_VERIFIED: policyCheck.ok ? "PASS" : "FAIL",
    JOURNAL_AND_REPLAY_SAFE: journal.ok ? "PASS" : "FAIL",
    PRE_BROADCAST_READY:
      blockers.length === 0
        ? "PASS"
        : engineeringPass && ownerPrereqOnly
          ? "READY_PENDING_OWNER_PREREQS"
          : "NO-GO",
    MAINNET_AUTONOMY_READY: "NO-GO",
  };

  report.verdict = report.gates.PRE_BROADCAST_READY;

  report.approval_preview_md = `# J17.1 — One-transfer approval preview

**Scenario:** \`${SCENARIO_LABEL}\`  
**Not Intents settlement.** Hard stop: this preview does **not** authorize MPC \`request_signature\` or EVM broadcast.

## Funding (already done)

| Item | Value |
|------|-------|
| MPC | [\`${J16_MPC}\`](https://sepolia.etherscan.io/address/${J16_MPC}) |
| ETH | ${ethWei.toString()} wei |
| Tidepool USDC | ${usdcRaw.toString()} raw |
| Evidence | \`docs/evidence/J17_CLAIM_AND_FUND_MPC.json\` |

## Policy (live views)

| View | Value |
|------|-------|
| paused | ${views.get_paused} |
| revoked | ${views.get_revocation_status?.revoked} |
| mandate_epoch | ${views.get_mandate_epoch} |
| autonomous_trading | ${views.get_autonomous_trading} |
| enforce_autonomous | ${views.get_enforce_autonomous_on_agent} |
| derivation_path | ${views.get_derivation_path} |
| reserved_pending | ${views.get_reserved_pending_exposure} |

## Planned transfer

| Field | Value |
|-------|-------|
| operation_id | \`${opId}\` |
| method | \`propose_quoted_evm_transfer\` then \`request_signature({ operation_id })\` + **1 yoctoNEAR** |
| token | \`${USDC_SEPOLIA}\` |
| from | \`${J16_MPC}\` |
| to | \`${TEST_RECIPIENT}\` (allowlisted test recipient) |
| amount | \`${AMOUNT_RAW}\` (1.0 USDC) |
| chain_id | \`${CHAIN_ID}\` |
| nonce | \`${nonce}\` (fresh) |
| gas_price | \`${gasPrice}\` wei |
| gas_limit | \`${gasLimit}\` (estimate ${estimated.toString()} + headroom; policy-bounded) |
| digest | \`${bind.digest_hex}\` |
| expected_epoch | \`${views.get_mandate_epoch}\` |

## ABI notes

- \`request_signature\` accepts **\`operation_id\` only**; payload is the reserved digest.
- **No** \`propose_trade\` fallback for \`0x\` destinations.
- **No** \`get_state\` — use real views listed above.
- Journal requires \`NIO_TX_JOURNAL_SECRET\` (no predictable fallback).

## Owner prereqs before broadcast approval

1. ${
    trusted === true
      ? "Trusted quote signer already registered."
      : `Owner call \`set_trusted_quote_signer({ public_key: \"${attestor.publicKey}\" })\` on \`${J16_POLICY}\`.`
  }
2. Set \`NIO_TX_JOURNAL_SECRET\` (≥32 chars) in the execution environment.
3. Separate explicit approval to set \`J17_SEPOLIA_FUNDING_AUTHORIZED=1\` and run broadcast (not this run).

## Gates

\`\`\`
${JSON.stringify(report.gates, null, 2)}
\`\`\`
`;

  report.next = {
    if_ready:
      "Separate owner approval → set NIO_TX_JOURNAL_SECRET → set_trusted_quote_signer if needed → J17_SEPOLIA_FUNDING_AUTHORIZED=1 → npm run j17:mpc-broadcast",
    this_run: "stopped_at_PRE_BROADCAST_READY",
  };

  finish(0);
} catch (e) {
  report.verdict = "NO_GO";
  report.error = String(e.message || e).slice(0, 1200);
  report.gates = {
    FUNDING_CONFIRMED: "UNKNOWN",
    CONTRACT_ABI_MATCH: "FAIL",
    SIGNATURE_DEPOSIT_CORRECT: "FAIL",
    DIGEST_BINDING_VALID: "FAIL",
    GAS_ESTIMATION_VALID: "FAIL",
    POLICY_STATE_VERIFIED: "FAIL",
    JOURNAL_AND_REPLAY_SAFE: "FAIL",
    PRE_BROADCAST_READY: "NO-GO",
    MAINNET_AUTONOMY_READY: "NO-GO",
  };
  finish(1);
}
