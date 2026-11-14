/**
 * J17.1 — Sepolia MPC→ERC-20 path helpers (ABI-aligned with contracts/policy).
 * Labeled DETERMINISTIC_TESTNET_ERC20_TRANSFER_NOT_INTENTS — not Intents settlement.
 */
import { createHash, randomBytes } from "node:crypto";
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
export const J16_MPC = "0x9a82c26b3d158cf4b657ab2a3ef9e5e6c2934d55";
export const J16_PATH = "trading/v1/portfolio/j16-mpc-6890";
export const USDC_SEPOLIA = "0x2e6AD9E6D59bB4585ea0E6762c3b637dde29DAD2";
/** Mandate-allowlisted test recipient (not an Intents escrow). */
export const TEST_RECIPIENT = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
export const AMOUNT_RAW = "1000000"; // 1.0 USDC — equals max_trade_value on J16 policy
export const GAS_HEADROOM_BPS = 2000; // +20%
export const GAS_ABS_MAX = 400000n; // hard ceiling before policy budget check

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
 */
export function fitGasLimit({
  estimated,
  headroomBps = GAS_HEADROOM_BPS,
  absMax = GAS_ABS_MAX,
  gasPrice,
  maxGasBudget,
}) {
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
  };
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

export function requireJournalSecret() {
  const s = process.env.NIO_TX_JOURNAL_SECRET;
  if (!s || String(s).length < 32) {
    return {
      ok: false,
      reason: "NIO_TX_JOURNAL_SECRET_required_no_predictable_fallback",
    };
  }
  return { ok: true };
}

export { publicKeyEd25519 };
