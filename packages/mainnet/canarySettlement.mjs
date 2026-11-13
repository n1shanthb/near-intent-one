/**
 * 1Click settlement monitoring via depositAddress (not correlationId alone).
 * Source/destination verifiers are parameterized for multichain canaries.
 */
import { getExecutionStatus, normalizeIntentStatus } from "./intents.mjs";
import { MAINNET_USDC, MAINNET_EVM_RPCS } from "./identities.mjs";
import { ARBITRUM_NATIVE_USDC } from "./arbitrumFunding.mjs";
import { evmErc20Balance } from "./evmBalances.mjs";
import { NEAR_NATIVE_USDC_CONTRACT } from "./canaryRouteProfiles.mjs";

async function ethRpc(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

/**
 * Verify EVM source receipt: status + ERC-20 Transfer MPC→escrow for exact amount.
 * Defaults remain J8B Arb USDC; pass ethereum rpc/token for Mission 1.
 */
export async function verifySourceUsdcTransfer({
  txHash,
  mpc,
  escrow,
  amount = "1000000",
  rpcUrl = MAINNET_EVM_RPCS.arbitrum,
  token = ARBITRUM_NATIVE_USDC,
  expectedChainId = null,
}) {
  const rcpt = await ethRpc(rpcUrl, "eth_getTransactionReceipt", [txHash]);
  if (!rcpt.result) {
    return { ok: false, reason: "receipt_missing", status: "UNKNOWN" };
  }
  const r = rcpt.result;
  if (r.status !== "0x1") {
    return { ok: false, reason: "receipt_failed", status: "FAILED", receipt: { status: r.status } };
  }
  if (expectedChainId != null) {
    const got = r.chainId != null ? Number(r.chainId) : null;
    // Many RPCs omit chainId on receipts; when present it must match.
    if (got != null && got !== Number(expectedChainId)) {
      return {
        ok: false,
        reason: "receipt_chain_id_mismatch",
        status: "FAILED",
        got_chain_id: got,
        expected_chain_id: Number(expectedChainId),
      };
    }
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
 * EVM destination USDC balance delta — no double counting.
 * `verifyBaseUsdcDelta` kept as the Base-default alias for J8B.
 */
export async function verifyEvmUsdcDelta({
  holder,
  beforeRaw,
  minAmountOut,
  rpcUrl = MAINNET_EVM_RPCS.base,
  token = MAINNET_USDC.base,
}) {
  const after = await evmErc20Balance(rpcUrl, token, holder);
  if (!after.ok) return { ok: false, reason: "evm_balance_read_failed" };
  const delta = BigInt(after.raw) - BigInt(beforeRaw || "0");
  const min = BigInt(minAmountOut);
  return {
    ok: delta >= min,
    before_raw: String(beforeRaw || "0"),
    after_raw: after.raw,
    delta: delta.toString(),
    min_amount_out: String(minAmountOut),
    token: String(token).toLowerCase(),
    holder: String(holder).toLowerCase(),
  };
}

export async function verifyBaseUsdcDelta({
  mpc,
  beforeRaw,
  minAmountOut,
  rpcUrl = MAINNET_EVM_RPCS.base,
  token = MAINNET_USDC.base,
}) {
  return verifyEvmUsdcDelta({
    holder: mpc,
    beforeRaw,
    minAmountOut,
    rpcUrl,
    token,
  });
}

async function nearViewFunction(rpcUrl, accountId, method, args = {}) {
  const body = {
    jsonrpc: "2.0",
    id: "1",
    method: "query",
    params: {
      request_type: "call_function",
      finality: "final",
      account_id: accountId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    },
  };
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (j.error) return { ok: false, reason: "rpc_error", detail: j.error };
  if (j.result?.error) {
    return { ok: false, reason: "view_error", detail: j.result.error };
  }
  if (!j.result?.result) return { ok: true, value: null };
  const raw = Buffer.from(j.result.result).toString("utf8");
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: true, value: raw };
  }
}

/**
 * NEAR NEP-141 ft_balance_of delta at recipient (Mission 1 destination).
 * Distinguishes NEP-141 contract balances from wrap.near / intents balances.
 */
export async function verifyNearNep141Delta({
  accountId,
  beforeRaw,
  minAmountOut,
  tokenContract = NEAR_NATIVE_USDC_CONTRACT,
  rpcUrl,
  nearRpc = null,
}) {
  const rpc = rpcUrl || nearRpc;
  if (!rpc) return { ok: false, reason: "near_rpc_required" };
  if (!accountId) return { ok: false, reason: "account_id_required" };
  const bal = await nearViewFunction(rpc, tokenContract, "ft_balance_of", {
    account_id: accountId,
  });
  if (!bal.ok) return { ok: false, reason: "near_ft_balance_read_failed", detail: bal };
  const afterRaw = String(bal.value ?? "0");
  const delta = BigInt(afterRaw) - BigInt(beforeRaw || "0");
  const min = BigInt(minAmountOut);
  return {
    ok: delta >= min,
    before_raw: String(beforeRaw || "0"),
    after_raw: afterRaw,
    delta: delta.toString(),
    min_amount_out: String(minAmountOut),
    token_contract: tokenContract,
    account_id: accountId,
    kind: "nep141",
  };
}

/**
 * Confirm recipient has FT storage registered (required before first credit).
 */
export async function checkNearFtStorageRegistered({
  accountId,
  tokenContract = NEAR_NATIVE_USDC_CONTRACT,
  rpcUrl,
}) {
  if (!rpcUrl) return { ok: false, reason: "near_rpc_required" };
  const [bal, bounds] = await Promise.all([
    nearViewFunction(rpcUrl, tokenContract, "storage_balance_of", {
      account_id: accountId,
    }),
    nearViewFunction(rpcUrl, tokenContract, "storage_balance_bounds", {}),
  ]);
  if (!bal.ok) return { ok: false, reason: "storage_balance_read_failed", detail: bal };
  const registered = bal.value != null && bal.value !== null;
  return {
    ok: registered,
    registered,
    storage_balance: bal.value,
    storage_bounds: bounds.ok ? bounds.value : null,
    account_id: accountId,
    token_contract: tokenContract,
    note: registered
      ? null
      : "Owner must storage_deposit on the NEP-141 before receiving",
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
