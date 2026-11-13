/**
 * J8B-0 — 1Click settlement monitoring via depositAddress (not correlationId alone).
 */
import { getExecutionStatus, normalizeIntentStatus } from "./intents.mjs";
import { MAINNET_USDC, MAINNET_EVM_RPCS } from "./identities.mjs";
import { ARBITRUM_NATIVE_USDC } from "./arbitrumFunding.mjs";
import { evmErc20Balance } from "./evmBalances.mjs";

async function ethRpc(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

/**
 * Verify Arbitrum source receipt: status, chain, Transfer MPC→escrow for native USDC.
 */
export async function verifySourceUsdcTransfer({
  txHash,
  mpc,
  escrow,
  amount = "1000000",
  rpcUrl = MAINNET_EVM_RPCS.arbitrum,
  token = ARBITRUM_NATIVE_USDC,
}) {
  const rcpt = await ethRpc(rpcUrl, "eth_getTransactionReceipt", [txHash]);
  if (!rcpt.result) {
    return { ok: false, reason: "receipt_missing", status: "UNKNOWN" };
  }
  const r = rcpt.result;
  if (r.status !== "0x1") {
    return { ok: false, reason: "receipt_failed", status: "FAILED", receipt: { status: r.status } };
  }
  const tokenLc = token.toLowerCase();
  const mpcLc = mpc.toLowerCase();
  const escrowLc = escrow.toLowerCase();
  const transferTopic =
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const logs = (r.logs || []).filter(
    (l) =>
      String(l.address || "").toLowerCase() === tokenLc &&
      l.topics?.[0]?.toLowerCase() === transferTopic
  );
  let matched = null;
  for (const log of logs) {
    const from = "0x" + String(log.topics[1] || "").slice(26).toLowerCase();
    const to = "0x" + String(log.topics[2] || "").slice(26).toLowerCase();
    const value = BigInt(log.data || "0x0");
    if (from === mpcLc && to === escrowLc && value === BigInt(amount)) {
      matched = { from, to, value: value.toString() };
      break;
    }
  }
  if (!matched) {
    return {
      ok: false,
      reason: "transfer_event_mismatch",
      status: "FAILED",
      logs_seen: logs.length,
    };
  }
  return {
    ok: true,
    status: "CONFIRMED",
    tx_hash: txHash,
    token: tokenLc,
    transfer: matched,
    gas_used: r.gasUsed ? BigInt(r.gasUsed).toString() : null,
  };
}

/**
 * Poll 1Click status by depositAddress.
 */
export async function monitorOneClickByDeposit({
  depositAddress,
  opts = {},
  maxPolls = 1,
  pollFn = getExecutionStatus,
}) {
  if (!depositAddress) {
    return { ok: false, reason: "deposit_address_required" };
  }
  let last = null;
  for (let i = 0; i < maxPolls; i++) {
    last = await pollFn(depositAddress, opts);
    const norm = last?.normalized || normalizeIntentStatus(last?.status || last?.body);
    if (["SUCCESS", "FAILED", "REFUNDED"].includes(norm)) {
      return {
        ok: norm === "SUCCESS",
        terminal: true,
        normalized: norm,
        deposit_address: depositAddress,
        raw: last,
      };
    }
  }
  return {
    ok: false,
    terminal: false,
    normalized: last?.normalized || "PENDING",
    deposit_address: depositAddress,
    raw: last,
    reason: "settlement_incomplete",
  };
}

/**
 * Base USDC balance delta at MPC — no double counting.
 */
export async function verifyBaseUsdcDelta({
  mpc,
  beforeRaw,
  minAmountOut,
  rpcUrl = MAINNET_EVM_RPCS.base,
  token = MAINNET_USDC.base,
}) {
  const after = await evmErc20Balance(rpcUrl, token, mpc);
  if (!after.ok) return { ok: false, reason: "base_balance_read_failed" };
  const delta = BigInt(after.raw) - BigInt(beforeRaw || "0");
  const min = BigInt(minAmountOut);
  return {
    ok: delta >= min,
    before_raw: String(beforeRaw || "0"),
    after_raw: after.raw,
    delta: delta.toString(),
    min_amount_out: String(minAmountOut),
    token: token.toLowerCase(),
  };
}

export function settlementRecoverySteps(normalized) {
  const common = [
    "Do not resign a different digest at the same nonce",
    "Do not create a second canary approval for a duplicate deposit",
    "Keep autonomous_trading=false",
    "Ledger pause() to close the execution window if still open",
  ];
  switch (String(normalized || "").toUpperCase()) {
    case "SUCCESS":
      return [
        "Verify Base USDC delta >= min_amount_out",
        "Reconcile policy pending op to settled only after evidence complete",
        "Ledger pause()",
        ...common,
      ];
    case "REFUNDED":
      return [
        "Confirm Arbitrum USDC returned to MPC or refund address",
        "Mark journal REFUNDED; do not count as trade success",
        "Ledger pause()",
        ...common,
      ];
    case "FAILED":
      return [
        "Inspect 1Click failure reason via depositAddress status",
        "If escrow received funds, follow official recovery — do not redeposit",
        "Ledger pause()",
        ...common,
      ];
    case "INCOMPLETE_DEPOSIT":
    case "PENDING":
      return [
        "Continue polling GET /v0/status?depositAddress=...",
        "If broadcast UNKNOWN: reconcile by tx hash / nonce before any action",
        "If MPC signed but not broadcast: retain journal; operator reconciliation only",
        ...common,
      ];
    default:
      return [
        "Treat as UNKNOWN — reconcile chain + 1Click before any mutation",
        ...common,
      ];
  }
}
