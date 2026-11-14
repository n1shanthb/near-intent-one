/**
 * J17.1–J17.3 — Sepolia MPC→ERC-20 path helpers (ABI-aligned with contracts/policy).
 * Labeled DETERMINISTIC_TESTNET_ERC20_TRANSFER_NOT_INTENTS — not Intents settlement.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import {
  attestationMessageV2,
  signAttestation,
  publicKeyEd25519,
  attestationId,
  erc20TransferData,
  eip155UnsignedDigest,
  digestHex,
} from "../intents-codec/quote-auth.mjs";

export const SCENARIO_LABEL = "DETERMINISTIC_TESTNET_ERC20_TRANSFER_NOT_INTENTS";
export const CHAIN_ID = 11155111;
export const J16_POLICY = "j16f6890.testnet";
export const J16_OWNER = "nio-owner-02b7cf.testnet";
export const J16_AGENT = "nio-agent-02b7cf.testnet";
export const J16_MPC = "0x9a82c26b3d158cf4b657ab2a3ef9e5e6c2934d55";
export const J16_PATH = "trading/v1/portfolio/j16-mpc-6890";
export const USDC_SEPOLIA = "0x2e6AD9E6D59bB4585ea0E6762c3b637dde29DAD2";
/** Mandate-allowlisted test recipient (not an Intents escrow). */
export const TEST_RECIPIENT = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
export const AMOUNT_RAW = "1000000"; // 1.0 USDC — equals max_trade_value on J16 policy
export const GAS_HEADROOM_BPS = 2000; // +20%
export const GAS_ABS_MAX = 400000n; // hard ceiling before policy budget check
/** Known local quote-attestor public key (must match seed cryptographically). */
export const EXPECTED_ATTESTOR_PK =
  "ed25519:FpYz8GbzcFDmmHcFVffnVSJfroguqZVudNU6yt6Wuozh";
/** Dual owner-auth env keys — funding auth ≠ signer register ≠ sign/broadcast. */
export const AUTH_QUOTE_SIGNER_REGISTER = "J17_QUOTE_SIGNER_REGISTER_AUTHORIZED";
export const AUTH_QUOTE_SIGNER_REVOKE = "J17_QUOTE_SIGNER_REVOKE_AUTHORIZED";
export const AUTH_MPC_SIGN_BROADCAST = "J17_MPC_SIGN_BROADCAST_AUTHORIZED";
/** Observed historical Tidepool transfer gas — NEVER satisfies readiness alone. */
export const HISTORICAL_GAS_OBSERVED = 142000n;

/** Durable operation-intent statuses (persist before propose). */
export const OP_INTENT_STATUS = Object.freeze({
  INTENT_LOCKED: "INTENT_LOCKED",
  PROPOSE_AMBIGUOUS: "PROPOSE_AMBIGUOUS",
  PROPOSED: "PROPOSED",
  PRE_SIGN_LOCKED: "PRE_SIGN_LOCKED",
  MPC_AMBIGUOUS: "MPC_AMBIGUOUS",
  MPC_SIGNED: "MPC_SIGNED",
  BROADCAST: "BROADCAST",
  TERMINAL_FAIL: "TERMINAL_FAIL",
});

const OP_INTENT_OPEN = new Set([
  OP_INTENT_STATUS.INTENT_LOCKED,
  OP_INTENT_STATUS.PROPOSE_AMBIGUOUS,
  OP_INTENT_STATUS.PROPOSED,
  OP_INTENT_STATUS.PRE_SIGN_LOCKED,
  OP_INTENT_STATUS.MPC_AMBIGUOUS,
  OP_INTENT_STATUS.MPC_SIGNED,
]);

/** Real policy view methods — never invent get_state. */
export const POLICY_VIEWS = [
  "get_paused",
  "get_mandate_epoch",
  "get_autonomous_trading",
  "get_enforce_autonomous_on_agent",
  "get_revocation_status",
  "get_gate_j_mandate",
  "get_limits",
  "get_agent",
  "get_owner",
  "get_intents_signer_id",
  "get_derivation_path",
  "get_reserved_pending_exposure",
];

/**
 * ABI contract for propose / request_signature (must match contracts/policy/src/lib.rs).
 */
export function expectedProposeQuotedEvmAbi() {
  return {
    method: "propose_quoted_evm_transfer",
    args: [
      "operation_id",
      "attestation",
      "attestation_signature",
      "signer_public_key",
      "tx",
      "expected_epoch",
    ],
    deposit_yocto: "0",
  };
}

export function expectedRequestSignatureAbi() {
  return {
    method: "request_signature",
    args: ["operation_id"], // payload comes from reserved pending — never agent-supplied
    deposit_yocto: "1",
    note: "attach at least 1 yoctoNEAR",
  };
}

export function assertRequestSignatureArgs(args) {
  const keys = Object.keys(args || {});
  if (keys.length !== 1 || keys[0] !== "operation_id") {
    return {
      ok: false,
      reason: "request_signature_accepts_operation_id_only",
      keys,
    };
  }
  if (!args.operation_id) {
    return { ok: false, reason: "operation_id_required" };
  }
  return { ok: true };
}

export function assertProposeQuotedArgs(args) {
  const required = expectedProposeQuotedEvmAbi().args;
  const missing = required.filter((k) => args?.[k] === undefined || args?.[k] === null);
  if (missing.length) {
    return { ok: false, reason: "propose_quoted_missing_fields", missing };
  }
  const att = args.attestation;
  const attReq = [
    "deposit_address",
    "amount_in",
    "asset_in",
    "asset_out",
    "min_amount_out",
    "quote_deadline_ns",
    "token_contract",
    "chain_id",
    "recipient",
    "refund_to",
    "correlation_id",
    "quote_hash",
    "max_gas_price",
    "gas_limit",
  ];
  const attMissing = attReq.filter((k) => att?.[k] === undefined || att?.[k] === null);
  if (attMissing.length) {
    return { ok: false, reason: "attestation_incomplete", missing: attMissing };
  }
  const txReq = [
    "nonce",
    "gas_price",
    "gas_limit",
    "chain_id",
    "token_contract",
    "to",
    "amount",
  ];
  const txMissing = txReq.filter(
    (k) => args.tx?.[k] === undefined || args.tx?.[k] === null
  );
  if (txMissing.length) {
    return { ok: false, reason: "evm_tx_params_incomplete", missing: txMissing };
  }
  return { ok: true };
}

/**
 * Refuse malformed propose_trade fallback for EVM destinations.
 */
export function refuseProposeTradeEvmFallback({ destination }) {
  if (String(destination || "").toLowerCase().startsWith("0x")) {
    return {
      ok: false,
      action: "REFUSE",
      reason: "evm_destinations_require_propose_quoted_evm_transfer",
      note: "Never auto-switch authorization methods after a rejected proposal",
    };
  }
  return { ok: true };
}

/**
 * Build a labeled deterministic attestation for a pure ERC-20 transfer.
 * deposit_address = ERC-20 transfer recipient (NOT Intents escrow).
 * Still authorized only via propose_quoted_evm_transfer + trusted signer on-chain.
 */
export function buildDeterministicErc20Attestation({
  secretKey64,
  depositAddress = TEST_RECIPIENT,
  tokenContract = USDC_SEPOLIA,
  amountIn = AMOUNT_RAW,
  chainId = CHAIN_ID,
  recipient = TEST_RECIPIENT,
  refundTo,
  maxGasPrice,
  gasLimit,
  correlationId,
  quoteHash,
  quoteDeadlineNs,
}) {
  if (!secretKey64 || secretKey64.length !== 64) {
    return { ok: false, reason: "attestor_secret_key_required" };
  }
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const deadline =
    quoteDeadlineNs !== undefined
      ? String(quoteDeadlineNs)
      : (nowNs + 7n * 24n * 3600n * 1_000_000_000n).toString();
  const corr =
    correlationId ||
    `j17-det-erc20-${randomBytes(4).toString("hex")}`;
  const qh =
    quoteHash ||
    createHash("sha256")
      .update(`${SCENARIO_LABEL}:${corr}:${depositAddress}:${amountIn}`)
      .digest("hex");

  const attestation = {
    deposit_address: String(depositAddress).toLowerCase(),
    amount_in: String(amountIn),
    asset_in: `eip155:${chainId}:${String(tokenContract).toLowerCase()}`,
    asset_out: "USDC",
    min_amount_out: String(amountIn), // 1:1 labeled transfer, not a swap
    quote_deadline_ns: deadline,
    token_contract: String(tokenContract).toLowerCase(),
    chain_id: String(chainId),
    recipient: String(recipient).toLowerCase(),
    refund_to: String(refundTo || recipient).toLowerCase(),
    correlation_id: corr,
    quote_hash: qh,
    max_gas_price: String(maxGasPrice),
    gas_limit: String(gasLimit),
  };

  const msg = attestationMessageV2({
    depositAddress: attestation.deposit_address,
    amountIn: attestation.amount_in,
    assetIn: attestation.asset_in,
    assetOut: attestation.asset_out,
    minAmountOut: attestation.min_amount_out,
    quoteDeadlineNs: attestation.quote_deadline_ns,
    tokenContract: attestation.token_contract,
    chainId: attestation.chain_id,
    recipient: attestation.recipient,
    refundTo: attestation.refund_to,
    correlationId: attestation.correlation_id,
    quoteHash: attestation.quote_hash,
    maxGasPrice: attestation.max_gas_price,
    gasLimit: attestation.gas_limit,
  });
  const signature = signAttestation(msg, secretKey64);
  const publicKey = publicKeyEd25519(secretKey64);

  return {
    ok: true,
    label: SCENARIO_LABEL,
    intents_settlement: false,
    note: "ERC-20 transfer ≠ Intents swap; attestation authorizes digest-bound transfer only",
    attestation,
    attestation_signature: signature,
    signer_public_key: publicKey,
    attestation_id: attestationId(msg),
    message_utf8: msg.toString("utf8"),
  };
}

/**
 * On-chain digest binding: EIP-155 to=token, data=transfer(deposit, amount).
 * Mirrors contracts/policy propose_quoted_evm_transfer.
 */
export function bindEip155DigestFromQuotedTx({
  nonce,
  gasPrice,
  gasLimit,
  chainId = CHAIN_ID,
  tokenContract,
  depositAddress,
  amount,
}) {
  const data = erc20TransferData(depositAddress, amount);
  const digestBytes = eip155UnsignedDigest({
    nonce: BigInt(nonce),
    gasPrice: BigInt(gasPrice),
    gasLimit: BigInt(gasLimit),
    to: tokenContract,
    value: 0n,
    data,
    chainId: Number(chainId),
  });
  return {
    digest_hex: digestHex(digestBytes),
    data_hex: "0x" + Buffer.from(data).toString("hex"),
    eip155_to: String(tokenContract).toLowerCase(),
    transfer_to: String(depositAddress).toLowerCase(),
    amount: String(amount),
  };
}

export function validateQuotedTxAgainstAttestation({ attestation, tx }) {
  const blockers = [];
  if (String(tx.to).toLowerCase() !== String(attestation.deposit_address).toLowerCase()) {
    blockers.push("tx.to_ne_attested_deposit");
  }
  if (
    String(tx.token_contract).toLowerCase() !==
    String(attestation.token_contract).toLowerCase()
  ) {
    blockers.push("tx.token_ne_attested_token");
  }
  if (String(tx.amount) !== String(attestation.amount_in)) {
    blockers.push("tx.amount_ne_attested_amount");
  }
  if (String(tx.chain_id) !== String(attestation.chain_id)) {
    blockers.push("tx.chain_id_mismatch");
  }
  if (String(tx.gas_limit) !== String(attestation.gas_limit)) {
    blockers.push("tx.gas_limit_ne_attested");
  }
  if (BigInt(tx.gas_price) <= 0n) blockers.push("tx.gas_price_required");
  if (BigInt(tx.gas_price) > BigInt(attestation.max_gas_price)) {
    blockers.push("tx.gas_price_above_attested_max");
  }
  return { ok: blockers.length === 0, blockers };
}

/**
 * Apply estimateGas + headroom, clamp to abs max and policy max_gas_budget.
 * Callers must pass a FRESH eth_estimateGas result — historical values fail readiness.
 */
export function fitGasLimit({
  estimated,
  headroomBps = GAS_HEADROOM_BPS,
  absMax = GAS_ABS_MAX,
  gasPrice,
  maxGasBudget,
  source = null,
}) {
  if (source === "historical" || source === "fallback" || source === "cached") {
    return {
      ok: false,
      reason: "historical_gas_estimate_never_satisfies_readiness",
      source,
      estimated: String(estimated),
    };
  }
  if (estimated === undefined || estimated === null || estimated === "") {
    return { ok: false, reason: "fresh_eth_estimateGas_required" };
  }
  const est = BigInt(estimated);
  const withHeadroom = (est * (10000n + BigInt(headroomBps))) / 10000n;
  let gasLimit = withHeadroom > absMax ? absMax : withHeadroom;
  if (gasLimit < est) gasLimit = est;
  const price = BigInt(gasPrice);
  const budget = BigInt(maxGasBudget);
  if (budget > 0n && price > 0n) {
    const maxByBudget = budget / price;
    if (maxByBudget < est) {
      return {
        ok: false,
        reason: "estimate_exceeds_max_gas_budget",
        estimated: est.toString(),
        max_by_budget: maxByBudget.toString(),
      };
    }
    if (gasLimit > maxByBudget) gasLimit = maxByBudget;
  }
  return {
    ok: true,
    estimated: est.toString(),
    gas_limit: gasLimit.toString(),
    headroom_bps: headroomBps,
    gas_cost: (price * gasLimit).toString(),
    source: source || "eth_estimateGas",
  };
}

/**
 * Fail-closed wrapper: only a live eth_estimateGas result may satisfy signing readiness.
 */
export function requireFreshGasEstimate({
  estimateHexOrBigInt,
  estimateError = null,
  gasPrice,
  maxGasBudget,
  usedHistoricalFallback = false,
}) {
  if (usedHistoricalFallback || estimateError) {
    return {
      ok: false,
      reason: usedHistoricalFallback
        ? "historical_gas_estimate_never_satisfies_readiness"
        : "eth_estimateGas_failed_fail_closed",
      estimate_error: estimateError
        ? String(estimateError).slice(0, 400)
        : null,
      historical_observed_only: HISTORICAL_GAS_OBSERVED.toString(),
      note: "Historical ~142k is documentary only — never used for PRE_SIGN / broadcast readiness",
    };
  }
  if (estimateHexOrBigInt === undefined || estimateHexOrBigInt === null) {
    return { ok: false, reason: "fresh_eth_estimateGas_required" };
  }
  return fitGasLimit({
    estimated: BigInt(estimateHexOrBigInt),
    gasPrice,
    maxGasBudget,
    source: "eth_estimateGas",
  });
}

/**
 * Verify live policy readiness from real view results (no get_state).
 */
export function verifyPolicyViews(views) {
  const blockers = [];
  if (views.get_paused === true) blockers.push("on_chain_paused");
  if (views.get_revocation_status?.revoked === true) blockers.push("on_chain_revoked");
  if (views.get_autonomous_trading !== true) blockers.push("autonomous_trading_required");
  if (views.get_enforce_autonomous_on_agent === true && views.get_autonomous_trading !== true) {
    blockers.push("enforce_autonomous_requires_trading");
  }
  const limits = views.get_limits || views.get_gate_j_mandate?.limits;
  if (limits?.valid_until) {
    const until = BigInt(limits.valid_until);
    const nowNs = BigInt(Date.now()) * 1_000_000n;
    if (until <= nowNs) blockers.push("mandate_expired");
  }
  const venues = limits?.allowed_venues || [];
  if (!venues.includes("near_intents_1click") && !venues.includes("evm_0x")) {
    blockers.push("venue_missing_near_intents_1click_or_evm_0x");
  }
  if (venues.includes("evm_transfer") && !venues.includes("evm_0x")) {
    // Informational — contract checks evm_0x, not evm_transfer
  }
  const dests = (limits?.allowed_destinations || []).map((d) =>
    String(d).toLowerCase()
  );
  if (!dests.includes(TEST_RECIPIENT.toLowerCase())) {
    blockers.push("test_recipient_not_allowlisted");
  }
  return {
    ok: blockers.length === 0,
    blockers,
    mandate_epoch: views.get_mandate_epoch,
    paused: views.get_paused,
    revoked: views.get_revocation_status?.revoked,
    autonomous_trading: views.get_autonomous_trading,
    derivation_path: views.get_derivation_path,
    intents_signer_id: views.get_intents_signer_id,
    venue_note:
      venues.includes("evm_transfer") && !venues.includes("evm_0x")
        ? "Policy lists evm_transfer; propose_quoted checks near_intents_1click|evm_0x — near_intents_1click present satisfies check"
        : null,
  };
}

/**
 * Journal secret for financial execution — fail closed, never regenerate on recovery.
 * Resolution order:
 * 1) NIO_TX_JOURNAL_SECRET
 * 2) NIO_TX_JOURNAL_SECRET_PATH (file)
 * 3) default `.nio-secure/j17/journal.secret` when rootDir provided
 */
export function journalSecretFilePath(rootDir) {
  return join(rootDir, ".nio-secure", "j17", "journal.secret");
}

export function journalSecretFingerprint(secret) {
  return createHash("sha256").update(String(secret)).digest("hex").slice(0, 16);
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, rootDir?: string|null, includeSecret?: boolean }} [opts]
 * When includeSecret=true, returns secret for the journal writer only — never log it.
 */
export function resolveJournalSecret({
  env = process.env,
  rootDir = null,
  includeSecret = false,
} = {}) {
  const fromEnv = env.NIO_TX_JOURNAL_SECRET;
  if (fromEnv && String(fromEnv).length >= 32) {
    const out = {
      ok: true,
      source: "env",
      length: String(fromEnv).length,
      fingerprint: journalSecretFingerprint(fromEnv),
    };
    if (includeSecret) out.secret = String(fromEnv);
    return out;
  }
  if (fromEnv && String(fromEnv).length > 0 && String(fromEnv).length < 32) {
    return { ok: false, reason: "NIO_TX_JOURNAL_SECRET_too_short" };
  }

  const pathCandidates = [];
  if (env.NIO_TX_JOURNAL_SECRET_PATH) {
    pathCandidates.push({
      path: String(env.NIO_TX_JOURNAL_SECRET_PATH),
      source: "path_env",
    });
  }
  if (rootDir) {
    pathCandidates.push({
      path: journalSecretFilePath(rootDir),
      source: "default_file",
    });
  }
  for (const c of pathCandidates) {
    if (!c.path || !existsSync(c.path)) continue;
    const secret = readFileSync(c.path, "utf8").trim();
    if (secret.length < 32) {
      return { ok: false, reason: "journal_secret_file_too_short", path: c.path };
    }
    const out = {
      ok: true,
      source: c.source,
      path: c.path,
      length: secret.length,
      fingerprint: journalSecretFingerprint(secret),
    };
    if (includeSecret) out.secret = secret;
    return out;
  }

  return {
    ok: false,
    reason: "NIO_TX_JOURNAL_SECRET_required_no_predictable_fallback",
    provision:
      "Set NIO_TX_JOURNAL_SECRET or NIO_TX_JOURNAL_SECRET_PATH, or provision .nio-secure/j17/journal.secret once; never regenerate on recovery",
  };
}

export function requireJournalSecret({
  env = process.env,
  rootDir = null,
  allowGenerate = false,
} = {}) {
  const resolved = resolveJournalSecret({ env, rootDir, includeSecret: false });
  if (resolved.ok) return resolved;
  if (allowGenerate && rootDir) {
    return {
      ok: false,
      reason: "journal_secret_missing_generate_only_via_explicit_provision",
      provision_hint:
        "Run scripts/j17/provision-journal-secret.mjs once under owner control; never auto-regenerate on crash recovery",
    };
  }
  return resolved;
}

/**
 * Wire resolved file/env secret into process env so persistPreBroadcast / openTxJournal
 * see NIO_TX_JOURNAL_SECRET and NIO_TX_JOURNAL_SECRET_PATH consistently.
 * Does not print the secret. Does not regenerate.
 */
export function hydrateJournalSecretEnv({
  env = process.env,
  rootDir = null,
} = {}) {
  const resolved = resolveJournalSecret({ env, rootDir, includeSecret: true });
  if (!resolved.ok) return resolved;
  env.NIO_TX_JOURNAL_SECRET = resolved.secret;
  if (resolved.path) env.NIO_TX_JOURNAL_SECRET_PATH = resolved.path;
  return {
    ok: true,
    source: resolved.source,
    path: resolved.path || null,
    length: resolved.length,
    fingerprint: resolved.fingerprint,
  };
}

/**
 * Auth flag / secret file / preview alone never count as successful execution.
 * Requires a fresh live preflight evidence artifact with matching fingerprint age.
 */
export function requireLivePreflightForExecution({
  evidence,
  maxAgeMs = 5 * 60 * 1000,
  nowMs = Date.now(),
  authEnabled = false,
  secretConfigured = false,
  previewPresent = false,
}) {
  const blockers = [];
  const allowedKinds = new Set([
    "J17_2_PRE_SIGN_SAFETY",
    "J17_3_LIVE_PREFLIGHT",
    "J17_3_PRE_SIGN_SAFETY",
  ]);
  if (!evidence || !allowedKinds.has(evidence.kind)) {
    blockers.push("live_preflight_evidence_missing");
  }
  if (!evidence?.finished_at) {
    blockers.push("live_preflight_timestamp_missing");
  } else {
    const finished = Date.parse(evidence.finished_at);
    if (!Number.isFinite(finished) || nowMs - finished > maxAgeMs) {
      blockers.push("live_preflight_stale");
    }
  }
  const gates = evidence?.gates || {};
  const requiredPass = [
    "FUNDING_CONFIRMED",
    "PENDING_CONFLICT_SAFE",
    "GAS_ESTIMATION_FAIL_CLOSED",
    "ATTESTOR_KEY_VERIFIED",
    "ONE_TRANSFER_BOUNDARY",
    "POLICY_STATE_VERIFIED",
  ];
  for (const g of requiredPass) {
    if (gates[g] !== "PASS") blockers.push(`live_preflight_gate_${g}`);
  }
  if (gates.JOURNAL_AND_REPLAY_SAFE !== "PASS") {
    blockers.push("live_preflight_journal_not_ready");
  }
  if (gates.MAINNET_AUTONOMY_READY === "PASS") {
    blockers.push("mainnet_ready_must_remain_no_go");
  }
  // Presence of auth/secret/preview without live pass is insufficient
  if (blockers.length) {
    if (authEnabled) blockers.push("auth_flag_alone_not_execution");
    if (secretConfigured) blockers.push("secret_file_alone_not_execution");
    if (previewPresent) blockers.push("preview_alone_not_execution");
  }
  return {
    ok: blockers.length === 0,
    blockers: [...new Set(blockers)],
    note: "Live preflight must pass immediately before authorized transfer; flags/files/previews are not success",
  };
}

/** Cryptographically verify local attestor seed derives the expected public key. */
export function verifyAttestorKeyCorrespondence({
  secretKey64,
  storedPublicKey,
  expectedPublicKey = EXPECTED_ATTESTOR_PK,
}) {
  if (!secretKey64 || secretKey64.length !== 64) {
    return { ok: false, reason: "attestor_secret_key_invalid_length" };
  }
  const derived = publicKeyEd25519(secretKey64);
  const blockers = [];
  if (derived !== expectedPublicKey) {
    blockers.push("derived_pk_ne_expected");
  }
  if (storedPublicKey && storedPublicKey !== expectedPublicKey) {
    blockers.push("stored_pk_ne_expected");
  }
  if (storedPublicKey && storedPublicKey !== derived) {
    blockers.push("stored_pk_ne_derived");
  }
  return {
    ok: blockers.length === 0,
    blockers,
    derived_public_key: derived,
    expected_public_key: expectedPublicKey,
    // Never include secret material
  };
}

export const ATTESTOR_REVOCATION_PLAN = {
  method: "remove_trusted_quote_signer",
  contract: J16_POLICY,
  args: { public_key: EXPECTED_ATTESTOR_PK },
  actor: J16_OWNER,
  auth_env: AUTH_QUOTE_SIGNER_REVOKE,
  after_successful_testnet_transfer: [
    `Owner-authorized call remove_trusted_quote_signer({ public_key: "${EXPECTED_ATTESTOR_PK}" }) on ${J16_POLICY}`,
    "Independently verify is_trusted_quote_signer(pk) === false via view + receipt logs",
    "Rotate local .gate-i-data/attestor.seed.json offline; never commit the seed",
    "Do not reuse the disposable J16 attestor key on mainnet",
  ],
  seed_protection: [
    ".gate-i-data/ is gitignored",
    "**/attestor*.seed.json is gitignored",
    "Never print secretKey64 in evidence or logs",
  ],
};

/**
 * Analyze whether an existing unresolved pending op conflicts with the next one-transfer.
 * Does NOT clear pending — clearing requires separate verified authority.
 */
export function analyzePendingConflict({
  pendingList = [],
  reservedExposure,
  maxPendingExposure,
  nextAmount = AMOUNT_RAW,
  nextDestination = TEST_RECIPIENT,
  nextOperationId = null,
}) {
  const reserved = BigInt(reservedExposure ?? 0);
  const maxPend = BigInt(maxPendingExposure ?? 0);
  const next = BigInt(nextAmount);
  const headroom = maxPend - reserved;
  const ops = Array.isArray(pendingList) ? pendingList : [];
  const unresolved = ops.filter(
    (o) =>
      o &&
      o.settlement_state !== "Success" &&
      o.settlement_state !== "Failed" &&
      o.settlement_state !== "Expired"
  );
  const idCollision = nextOperationId
    ? unresolved.some((o) => o.operation_id === nextOperationId)
    : false;
  const sameDestOpen = unresolved.some(
    (o) =>
      String(o.destination || "").toLowerCase() ===
      String(nextDestination).toLowerCase()
  );
  const blockers = [];
  if (idCollision) blockers.push("operation_id_collision_with_pending");
  if (headroom < next) blockers.push("pending_exposure_headroom_insufficient");
  // Existing Signed+None NEAR-dest op is different path — note, do not auto-clear
  const notes = [];
  for (const o of unresolved) {
    notes.push({
      operation_id: o.operation_id,
      amount_in: String(o.amount_in?.toString?.() ?? o.amount_in),
      destination: o.destination,
      signing_state: o.signing_state,
      settlement_state: o.settlement_state,
      epoch: o.epoch,
      payload_commitment: o.payload_commitment || null,
      clear_without_authority: false,
      action: "LEAVE_IN_PLACE_UNTIL_RECONCILE_OR_OWNER_CLEAR",
    });
  }
  return {
    ok: blockers.length === 0,
    blockers,
    unresolved_count: unresolved.length,
    reserved: reserved.toString(),
    max_pending_exposure: maxPend.toString(),
    headroom: headroom.toString(),
    next_amount: next.toString(),
    fits_exposure: headroom >= next,
    id_collision: idCollision,
    same_destination_open: sameDestOpen,
    destination_overlap_note: sameDestOpen
      ? "An open pending shares the next EVM destination — inspect before proposing"
      : "Existing pending destination differs from next EVM recipient (no dest collision)",
    pending: notes,
    do_not_clear:
      "Do not clear unresolved pending without verified on-chain evidence and explicit owner authority",
  };
}

/** One-transfer approval boundary (exact envelope for J17 testnet). */
export function verifyOneTransferBoundary({
  chainId,
  token,
  destination,
  amountRaw,
  gasLimit,
  gasAbsMax = GAS_ABS_MAX,
  attemptedTransfers = 1,
}) {
  const blockers = [];
  if (Number(chainId) !== CHAIN_ID) blockers.push("chain_id_must_be_11155111");
  if (String(token).toLowerCase() !== USDC_SEPOLIA.toLowerCase()) {
    blockers.push("token_must_be_tidepool_testnet_usdc");
  }
  if (String(destination).toLowerCase() !== TEST_RECIPIENT.toLowerCase()) {
    blockers.push("destination_must_be_allowlisted_test_recipient");
  }
  if (BigInt(amountRaw) > BigInt(AMOUNT_RAW)) {
    blockers.push("amount_exceeds_fitter_approved_max_1000000");
  }
  if (BigInt(amountRaw) <= 0n) blockers.push("amount_must_be_positive");
  if (gasLimit !== undefined && BigInt(gasLimit) > gasAbsMax) {
    blockers.push("gas_limit_exceeds_bounded_maximum");
  }
  if (Number(attemptedTransfers) !== 1) {
    blockers.push("exactly_one_attempted_transfer_required");
  }
  return {
    ok: blockers.length === 0,
    blockers,
    envelope: {
      chain_id: CHAIN_ID,
      token: USDC_SEPOLIA,
      destination: TEST_RECIPIENT,
      max_amount_raw: AMOUNT_RAW,
      gas_abs_max: gasAbsMax.toString(),
      max_attempts: 1,
    },
  };
}

export function isAuthEnabled(envName, env = process.env) {
  return env[envName] === "1";
}

export function requireQuoteSignerRegisterAuth(env = process.env) {
  if (!isAuthEnabled(AUTH_QUOTE_SIGNER_REGISTER, env)) {
    return {
      ok: false,
      reason: `${AUTH_QUOTE_SIGNER_REGISTER}_required`,
      note: "Separate owner authorization for set_trusted_quote_signer — not funding, not broadcast",
    };
  }
  return { ok: true };
}

export function requireQuoteSignerRevokeAuth(env = process.env) {
  if (!isAuthEnabled(AUTH_QUOTE_SIGNER_REVOKE, env)) {
    return {
      ok: false,
      reason: `${AUTH_QUOTE_SIGNER_REVOKE}_required`,
      note: "Separate owner authorization for remove_trusted_quote_signer — post-test cleanup only",
    };
  }
  return { ok: true };
}

export function requireMpcSignBroadcastAuth(env = process.env) {
  // Funding auth must NOT unlock signing after funding is complete.
  if (isAuthEnabled("J17_SEPOLIA_FUNDING_AUTHORIZED", env) &&
      !isAuthEnabled(AUTH_MPC_SIGN_BROADCAST, env)) {
    return {
      ok: false,
      reason: "funding_auth_does_not_authorize_mpc_sign_or_broadcast",
      required: AUTH_MPC_SIGN_BROADCAST,
      note: "J17_SEPOLIA_FUNDING_AUTHORIZED is retired for sign/broadcast; use J17_MPC_SIGN_BROADCAST_AUTHORIZED=1",
    };
  }
  if (!isAuthEnabled(AUTH_MPC_SIGN_BROADCAST, env)) {
    return {
      ok: false,
      reason: `${AUTH_MPC_SIGN_BROADCAST}_required`,
      note: "Separate owner authorization for propose → request_signature → broadcast",
    };
  }
  return { ok: true };
}

function preSignIntentPath(storeDir, operationId) {
  return join(storeDir, `presign-${operationId}.json`);
}

function writeIntentAtomic(path, record) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2));
  renameSync(tmp, path);
}

/**
 * Create immutable operation intent BEFORE propose_quoted_evm_transfer.
 * If any open intent exists, resume it — never silently mint a new operation_id.
 */
export function createOperationIntent({
  storeDir,
  operationId,
  epoch,
  amount,
  destination,
  nonce,
  digestHex: digest,
  gasLimit,
  gasPrice,
  chainId = CHAIN_ID,
  token = USDC_SEPOLIA,
  secretFingerprint = null,
  forceNew = false,
}) {
  if (!storeDir || !operationId) {
    return { ok: false, reason: "storeDir_and_operationId_required" };
  }
  mkdirSync(storeDir, { recursive: true });
  const open = findOpenOperationIntents(storeDir);
  if (open.length && !forceNew) {
    const existing = open[0];
    return {
      ok: true,
      resumed: true,
      path: existing.path,
      record: existing.record,
      note: "Open operation intent found — recover this operation_id; do not generate a new one",
    };
  }
  const path = preSignIntentPath(storeDir, operationId);
  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, "utf8"));
    return {
      ok: true,
      resumed: true,
      path,
      record: existing,
      note: "Existing intent file found — resume, do not duplicate propose",
    };
  }
  const record = {
    kind: "J17_OPERATION_INTENT",
    immutable: true,
    operation_id: operationId,
    epoch: Number(epoch),
    amount: String(amount),
    destination: String(destination).toLowerCase(),
    nonce: String(nonce),
    digest_hex: String(digest).toLowerCase().replace(/^0x/, ""),
    gas_limit: String(gasLimit),
    gas_price: String(gasPrice),
    chain_id: Number(chainId),
    token: String(token).toLowerCase(),
    signing_intent: "propose_then_request_signature",
    propose_near_tx: null,
    mpc_near_tx: null,
    secret_fingerprint: secretFingerprint,
    status: OP_INTENT_STATUS.INTENT_LOCKED,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  writeIntentAtomic(path, record);
  return { ok: true, resumed: false, path, record };
}

export function advanceOperationIntent({
  storeDir,
  operationId,
  status,
  patch = {},
}) {
  const loaded = loadPreSignIntent({ storeDir, operationId });
  if (!loaded.ok) return loaded;
  const record = {
    ...loaded.record,
    ...patch,
    status,
    updated_at: new Date().toISOString(),
  };
  // Immutable identity fields cannot change after create
  record.operation_id = loaded.record.operation_id;
  record.digest_hex = loaded.record.digest_hex;
  record.nonce = loaded.record.nonce;
  record.amount = loaded.record.amount;
  record.destination = loaded.record.destination;
  record.epoch = loaded.record.epoch;
  writeIntentAtomic(loaded.path, record);
  return { ok: true, path: loaded.path, record };
}

/**
 * Persist / resume helper kept for J17.2 callers; prefers create+advance semantics.
 */
export function persistPreSignIntent(args) {
  const created = createOperationIntent({
    ...args,
    forceNew: false,
  });
  if (!created.ok) return created;
  if (created.resumed) return created;
  if (args.status && args.status !== OP_INTENT_STATUS.INTENT_LOCKED) {
    return advanceOperationIntent({
      storeDir: args.storeDir,
      operationId: args.operationId,
      status: args.status,
      patch: {
        propose_near_tx: args.proposeNearTx || null,
        signing_intent: args.signingIntent || "request_signature",
      },
    });
  }
  return created;
}

export function loadPreSignIntent({ storeDir, operationId }) {
  const path = preSignIntentPath(storeDir, operationId);
  if (!existsSync(path)) {
    return { ok: false, reason: "presign_intent_not_found", path };
  }
  const record = JSON.parse(readFileSync(path, "utf8"));
  return { ok: true, path, record };
}

export function findOpenOperationIntents(storeDir) {
  if (!storeDir || !existsSync(storeDir)) return [];
  const out = [];
  for (const name of readdirSync(storeDir)) {
    if (!name.startsWith("presign-") || !name.endsWith(".json")) continue;
    try {
      const path = join(storeDir, name);
      const record = JSON.parse(readFileSync(path, "utf8"));
      if (OP_INTENT_OPEN.has(record.status)) {
        out.push({ path, record });
      }
    } catch {
      /* skip corrupt */
    }
  }
  return out.sort((a, b) =>
    String(a.record.created_at).localeCompare(String(b.record.created_at))
  );
}

export function findRecoverablePreSignIntents(storeDir) {
  return findOpenOperationIntents(storeDir);
}

/**
 * Decide whether a NEAR propose / request_signature may proceed given intent status.
 * Ambiguous prior outcomes never authorize a new operation_id.
 */
export function planNearMutation({ record, method }) {
  if (!record) {
    return {
      allowed: false,
      may_new_operation: false,
      reason: "intent_record_required",
    };
  }
  const status = record.status;
  if (method === "propose_quoted_evm_transfer") {
    if (status === OP_INTENT_STATUS.INTENT_LOCKED) {
      return { allowed: true, may_new_operation: false };
    }
    if (status === OP_INTENT_STATUS.PROPOSE_AMBIGUOUS) {
      return {
        allowed: false,
        may_new_operation: false,
        may_duplicate_propose: false,
        reason: "propose_ambiguous_recover_via_near_receipt_or_get_pending",
      };
    }
    if (
      status === OP_INTENT_STATUS.PROPOSED ||
      status === OP_INTENT_STATUS.PRE_SIGN_LOCKED ||
      status === OP_INTENT_STATUS.MPC_AMBIGUOUS ||
      status === OP_INTENT_STATUS.MPC_SIGNED
    ) {
      return {
        allowed: false,
        may_new_operation: false,
        may_duplicate_propose: false,
        reason: "propose_already_done_or_past",
      };
    }
  }
  if (method === "request_signature") {
    if (
      status === OP_INTENT_STATUS.PROPOSED ||
      status === OP_INTENT_STATUS.PRE_SIGN_LOCKED
    ) {
      return { allowed: true, may_new_operation: false };
    }
    if (status === OP_INTENT_STATUS.MPC_AMBIGUOUS) {
      return {
        allowed: false,
        may_new_operation: false,
        may_duplicate_request_signature: false,
        reason: "mpc_ambiguous_recover_via_near_receipt_no_resign",
      };
    }
    if (status === OP_INTENT_STATUS.MPC_SIGNED) {
      return {
        allowed: false,
        may_new_operation: false,
        may_duplicate_request_signature: false,
        reason: "mpc_already_signed",
      };
    }
    if (status === OP_INTENT_STATUS.INTENT_LOCKED) {
      return {
        allowed: false,
        may_new_operation: false,
        reason: "propose_required_before_request_signature",
      };
    }
  }
  return {
    allowed: false,
    may_new_operation: false,
    reason: `unsupported_status_method:${status}:${method}`,
  };
}

/**
 * Classify NEAR RPC mutation outcomes. Ambiguous ⇒ quarantine; never new op / never blind retry.
 */
export function evaluateNearMutationOutcome({
  method,
  priorStatus,
  confirmedReceipt = false,
  ambiguous = false,
  hardFailure = false,
}) {
  if (ambiguous) {
    const next =
      method === "propose_quoted_evm_transfer"
        ? OP_INTENT_STATUS.PROPOSE_AMBIGUOUS
        : OP_INTENT_STATUS.MPC_AMBIGUOUS;
    return {
      action: "QUARANTINE",
      next_status: next,
      may_retry: false,
      may_new_operation: false,
      may_duplicate: false,
      reason: "ambiguous_near_rpc_recover_via_receipt",
      prior_status: priorStatus,
    };
  }
  if (hardFailure) {
    return {
      action: "FAIL_CLOSED",
      next_status: OP_INTENT_STATUS.TERMINAL_FAIL,
      may_retry: false,
      may_new_operation: false,
      may_duplicate: false,
      reason: "near_mutation_hard_failure",
    };
  }
  if (confirmedReceipt) {
    if (method === "propose_quoted_evm_transfer") {
      return {
        action: "ADVANCE",
        next_status: OP_INTENT_STATUS.PROPOSED,
        may_retry: false,
        may_new_operation: false,
        may_duplicate: false,
      };
    }
    if (method === "request_signature") {
      return {
        action: "ADVANCE",
        next_status: OP_INTENT_STATUS.MPC_SIGNED,
        may_retry: false,
        may_new_operation: false,
        may_duplicate: false,
      };
    }
  }
  return {
    action: "QUARANTINE",
    next_status:
      method === "propose_quoted_evm_transfer"
        ? OP_INTENT_STATUS.PROPOSE_AMBIGUOUS
        : OP_INTENT_STATUS.MPC_AMBIGUOUS,
    may_retry: false,
    may_new_operation: false,
    may_duplicate: false,
    reason: "unconfirmed_near_outcome",
  };
}

export { publicKeyEd25519 };
