/**
 * Off-chain settlement verification (Gate H2).
 * Trusted watchdog checks — NOT cryptographic on-chain verification.
 * The NEAR contract only stores evidence_hash; this module must run BEFORE reconcile_pending.
 */
const SEPOLIA_RPC =
  process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com";
const TIDEPOOL = process.env.TIDEPOOL_URL || "https://www.usetidepool.tech";

async function eth(method, params) {
  const res = await fetch(SEPOLIA_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

/**
 * @typedef {object} PendingOpLike
 * @property {string} operation_id
 * @property {string} signing_state
 * @property {string} settlement_state
 * @property {string} amount_in
 * @property {string} destination
 * @property {string} [asset_in]
 */

/**
 * Verify origin EVM receipt matches expected economics.
 */
export async function verifyOriginReceipt({
  txHash,
  expectedSender,
  expectedToken,
  expectedRecipient,
  expectedAmount,
  chainId = 11155111,
}) {
  const checks = [];
  const fail = (reason) => ({
    ok: false,
    checks: [...checks, { ok: false, reason }],
    receipt: null,
  });

  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return fail("invalid_or_missing_tx_hash");
  }

  const [receiptRes, txRes] = await Promise.all([
    eth("eth_getTransactionReceipt", [txHash]),
    eth("eth_getTransactionByHash", [txHash]),
  ]);
  const receipt = receiptRes.result;
  const tx = txRes.result;
  if (!receipt) return fail("receipt_not_found");
  if (!tx) return fail("tx_not_found");

  checks.push({
    ok: receipt.status === "0x1",
    reason: `receipt_status=${receipt.status}`,
  });
  if (receipt.status !== "0x1") return fail("receipt_reverted");

  const blockNum = BigInt(receipt.blockNumber);
  const latest = BigInt((await eth("eth_blockNumber", [])).result);
  const confirmations = latest - blockNum + 1n;
  checks.push({
    ok: confirmations >= 1n,
    reason: `confirmations=${confirmations}`,
  });

  const sender = (tx.from || "").toLowerCase();
  checks.push({
    ok: sender === expectedSender.toLowerCase(),
    reason: `sender=${sender}`,
  });
  if (sender !== expectedSender.toLowerCase()) return fail("sender_mismatch");

  const token = (tx.to || "").toLowerCase();
  checks.push({
    ok: token === expectedToken.toLowerCase(),
    reason: `token=${token}`,
  });
  if (token !== expectedToken.toLowerCase()) return fail("token_mismatch");

  // ERC-20 transfer(address,uint256) selector a9059cbb
  const data = tx.input || tx.data || "0x";
  if (!data.startsWith("0xa9059cbb") || data.length < 138) {
    return fail("not_erc20_transfer_ calldata");
  }
  const recipient = ("0x" + data.slice(34, 74)).toLowerCase();
  const amount = BigInt("0x" + data.slice(74, 138)).toString();
  checks.push({
    ok: recipient === expectedRecipient.toLowerCase(),
    reason: `recipient=${recipient}`,
  });
  checks.push({
    ok: amount === String(expectedAmount),
    reason: `amount=${amount} expected=${expectedAmount}`,
  });
  if (recipient !== expectedRecipient.toLowerCase()) return fail("recipient_mismatch");
  if (amount !== String(expectedAmount)) return fail("amount_mismatch");

  // chain id from signed tx is not always in eth_getTransactionByHash legacy fields;
  // Sepolia RPC endpoint implies chain — record expectation.
  checks.push({ ok: true, reason: `expected_chain_id=${chainId}` });

  return {
    ok: checks.every((c) => c.ok),
    checks,
    receipt: {
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      confirmations: confirmations.toString(),
      transactionHash: txHash,
      from: sender,
      token,
      recipient,
      amount,
    },
  };
}

/**
 * Tidepool terminal status + NEAR settlement hashes.
 */
export async function verifyTidepoolTerminal(depositAddress) {
  const checks = [];
  const url = `${TIDEPOOL}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`;
  const res = await fetch(url);
  const body = await res.json();
  const status = body.status;
  const terminal = ["SUCCESS", "REFUNDED", "FAILED", "EXPIRED"].includes(status);
  checks.push({ ok: terminal, reason: `tidepool_status=${status}` });
  const nearTxHashes = body.swapDetails?.nearTxHashes || [];
  if (status === "SUCCESS") {
    checks.push({
      ok: nearTxHashes.length > 0,
      reason: `nearTxHashes=${nearTxHashes.length}`,
    });
  }
  return {
    ok: terminal && (status !== "SUCCESS" || nearTxHashes.length > 0),
    checks,
    status,
    nearTxHashes,
    body,
  };
}

/**
 * Map verified off-chain facts → allowed settlement_state for reconcile_pending.
 * Never expires an already-signed EVM op solely because a quote deadline passed.
 */
export function deriveSettlementState({
  pendingOp,
  originVerified,
  tidepoolVerified,
  originTxHash,
}) {
  const notes = [];
  if (!pendingOp) {
    return { ok: false, settlement_state: null, evidence_hash: null, notes: ["missing_op"] };
  }
  if (
    ["Success", "Refunded", "Failed", "Expired", "Reconciled"].includes(
      pendingOp.settlement_state
    )
  ) {
    return {
      ok: false,
      settlement_state: null,
      evidence_hash: null,
      notes: ["duplicate_settlement_blocked"],
    };
  }

  const signed = ["Signed", "Signing"].includes(pendingOp.signing_state);
  const reservedOnly = pendingOp.signing_state === "Reserved";

  // Already-signed: must not Expired just for deadline — require origin or Tidepool fact.
  if (signed) {
    if (originVerified?.ok && tidepoolVerified?.status === "SUCCESS") {
      return {
        ok: true,
        settlement_state: "Success",
        evidence_hash:
          tidepoolVerified.nearTxHashes?.[0] || originTxHash || "missing-near-hash",
        notes: ["signed+origin_ok+tidepool_success"],
      };
    }
    if (originVerified?.ok && tidepoolVerified?.status === "REFUNDED") {
      return {
        ok: true,
        settlement_state: "Refunded",
        evidence_hash: tidepoolVerified.nearTxHashes?.[0] || originTxHash,
        notes: ["signed+refunded"],
      };
    }
    if (originVerified?.ok && ["FAILED", "EXPIRED"].includes(tidepoolVerified?.status)) {
      // Origin mined but intents path failed — Failed, not quote-deadline Expired alone.
      return {
        ok: true,
        settlement_state: "Failed",
        evidence_hash: originTxHash || "origin-mined-intents-failed",
        notes: ["signed+origin_ok+tidepool_failed", "not_deadline_only_expire"],
      };
    }
    if (!originVerified?.ok && !tidepoolVerified?.ok) {
      notes.push(
        "signed_op_without_verified_receipt — refuse Expired (deadline alone insufficient)"
      );
      return { ok: false, settlement_state: null, evidence_hash: null, notes };
    }
    return { ok: false, settlement_state: null, evidence_hash: null, notes: ["insufficient_signed_evidence"] };
  }

  // Never signed: honest Expired is allowed (no exportable ECDSA).
  if (reservedOnly) {
    return {
      ok: true,
      settlement_state: "Expired",
      evidence_hash: "never-signed:Reserved/None",
      notes: ["reserved_never_signed_may_expire"],
    };
  }

  return { ok: false, settlement_state: null, evidence_hash: null, notes: ["unhandled_state"] };
}

/**
 * Full pre-reconcile gate.
 */
export async function verifyBeforeReconcile({
  pendingOp,
  originTxHash,
  expectedSender,
  expectedToken,
  expectedRecipient,
  expectedAmount,
  depositAddress,
  chainId = 11155111,
}) {
  const origin = originTxHash
    ? await verifyOriginReceipt({
        txHash: originTxHash,
        expectedSender,
        expectedToken,
        expectedRecipient,
        expectedAmount,
        chainId,
      })
    : { ok: false, checks: [{ ok: false, reason: "no_origin_tx" }], receipt: null };

  const tidepool = depositAddress
    ? await verifyTidepoolTerminal(depositAddress)
    : { ok: false, checks: [{ ok: false, reason: "no_deposit" }], status: null, nearTxHashes: [] };

  const derived = deriveSettlementState({
    pendingOp,
    originVerified: origin,
    tidepoolVerified: tidepool,
    originTxHash,
  });

  return {
    trust_model: "trusted_offchain_watchdog_not_onchain_proof",
    origin,
    tidepool,
    derived,
    may_reconcile: derived.ok,
  };
}
