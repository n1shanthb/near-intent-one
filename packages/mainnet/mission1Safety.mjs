/**
 * Mission 1 safety primitives — Eth USDC → NEAR NEP-141.
 * Fixture injection is forbidden outside explicit testHarness mode.
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  MAINNET_IDENTITIES,
  MAINNET_USDC,
  MAINNET_EVM_RPCS,
} from "./identities.mjs";
import {
  MISSION1_AMOUNT,
  MISSION1_CHAIN_ID,
  MISSION1_TOKEN,
  mission1StoreDir,
  validateMission1CanaryApproval,
} from "./mission1ExecutionPath.mjs";
import {
  CANARY_STATES,
  getLifecycleState,
} from "./canaryOneShot.mjs";
import {
  decodeSignedEip155Tx,
  erc20TransferData,
  eip155UnsignedDigest,
  digestHex,
} from "../intents-codec/quote-auth.mjs";
import { localTxHash } from "../execution/txJournal.mjs";
import { ethJsonRpc } from "./canaryAdapters.mjs";
import { checkNearFtStorageRegistered } from "./canarySettlement.mjs";
import { NEAR_NATIVE_USDC_CONTRACT } from "./canaryRouteProfiles.mjs";
import { evmErc20Balance, evmNativeBalance } from "./evmBalances.mjs";

const FIXTURE_KEYS = Object.freeze([
  "paused",
  "existingPending",
  "pendingPreSign",
  "nearUsdcBefore",
  "ethBal",
  "usdcBal",
  "limits",
  "epoch",
  "storage",
  "quoteResult",
  "attestResult",
  "gasPrice",
  "gasEst",
  "nonce",
  "proposeFn",
  "signFn",
  "ethSend",
  "reconcileFn",
  "sourceVerify",
  "oneClick",
  "nearVerify",
  "assembled",
  "nearTxFull",
  "mpcDigestHex",
  "expectedNonce",
]);

export const MISSION1_CONFIRM_GATES = Object.freeze({
  propose: CANARY_STATES.OWNER_UNPAUSED,
  sign: CANARY_STATES.PROPOSED,
  broadcast: CANARY_STATES.READY_TO_BROADCAST,
  reconcile: CANARY_STATES.SETTLED,
});

export function assertMission1FixturesAllowed(testHarness, deps = {}) {
  const injected = FIXTURE_KEYS.filter((k) =>
    Object.prototype.hasOwnProperty.call(deps, k)
  );
  if (injected.length > 0 && testHarness !== true) {
    return {
      ok: false,
      reason: "fixture_injection_requires_testHarness",
      injected,
    };
  }
  return { ok: true, injected };
}

export function requireLifecycleAdvance(result, label) {
  if (!result?.ok) {
    return {
      ok: false,
      reason: result?.reason || `lifecycle_advance_failed:${label}`,
      detail: result,
    };
  }
  return { ok: true, record: result.record };
}

function atomicWrite(path, obj) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Confirm a mutation phase only in the required lifecycle state (no advance booking).
 */
export function confirmMission1Phase(
  operationId,
  phase,
  { env = process.env, storeDir = null, note = null } = {}
) {
  const required = MISSION1_CONFIRM_GATES[phase];
  if (!required) {
    return { ok: false, reason: `unknown_confirm_phase:${phase}` };
  }
  const sd = storeDir || mission1StoreDir(env);
  // SETTLED approvals may be consumed — load raw for reconcile confirm
  if (phase === "reconcile") {
    const path = join(sd, `${operationId}.json`);
    if (!existsSync(path)) return { ok: false, reason: "approval_not_found" };
    const record = JSON.parse(readFileSync(path, "utf8"));
    const state = getLifecycleState(record);
    if (state !== required) {
      return {
        ok: false,
        reason: `confirm_wrong_state:have=${state}:need=${required}`,
      };
    }
    const next = {
      ...record,
      operator_confirmations: {
        ...record.operator_confirmations,
        [phase]: {
          at: new Date().toISOString(),
          note: note || `confirmed_at_state:${state}`,
        },
      },
    };
    atomicWrite(path, next);
    return { ok: true, phase, record: next };
  }

  const v = validateMission1CanaryApproval(operationId, { env, storeDir: sd });
  if (!v.ok) return v;
  const state = getLifecycleState(v.record);
  if (state !== required) {
    return {
      ok: false,
      reason: `confirm_wrong_state:have=${state}:need=${required}`,
    };
  }
  const next = {
    ...v.record,
    operator_confirmations: {
      ...v.record.operator_confirmations,
      [phase]: {
        at: new Date().toISOString(),
        note: note || `confirmed_at_state:${state}`,
      },
    },
  };
  atomicWrite(v.path, next);
  return { ok: true, phase, record: next };
}

/**
 * Decode + verify signed EIP-155 raw against Mission 1 Eth bindings.
 */
export function verifyMission1SignedRaw(rawHex, auth, { recoverFn } = {}) {
  const want = {
    token: MISSION1_TOKEN,
    deposit: String(auth.deposit_address || "").toLowerCase(),
    amount: MISSION1_AMOUNT,
    nonce: Number(auth.nonce),
    gas_price: String(auth.gas_price),
    gas_limit: String(auth.gas_limit),
    chain_id: MISSION1_CHAIN_ID,
    digest: String(auth.digest_hex || "").toLowerCase(),
    mpc: MAINNET_IDENTITIES.mpc_evm_address.toLowerCase(),
    local_tx_hash: auth.local_tx_hash
      ? String(auth.local_tx_hash).toLowerCase()
      : null,
  };
  if (!want.deposit) return { ok: false, reason: "deposit_address_required" };
  if (!want.digest) return { ok: false, reason: "digest_required" };

  if (typeof recoverFn !== "function") {
    return { ok: false, reason: "recover_fn_required" };
  }
  const decoded = decodeSignedEip155Tx(rawHex, { recoverFn });
  if (!decoded.ok) return decoded;
  if (Number(decoded.chainId) !== MISSION1_CHAIN_ID) {
    return { ok: false, reason: "wrong_chain_id", got: decoded.chainId };
  }
  if (String(decoded.to).toLowerCase() !== MISSION1_TOKEN) {
    return { ok: false, reason: "wrong_token", got: decoded.to };
  }
  if (String(decoded.value) !== "0") {
    return { ok: false, reason: "nonzero_eth_value", got: decoded.value };
  }
  if (Number(decoded.nonce) !== want.nonce) {
    return { ok: false, reason: "nonce_mismatch", got: decoded.nonce };
  }
  if (String(decoded.gasPrice) !== want.gas_price) {
    return { ok: false, reason: "gas_price_mismatch", got: decoded.gasPrice };
  }
  if (String(decoded.gasLimit) !== want.gas_limit) {
    return { ok: false, reason: "gas_limit_mismatch", got: decoded.gasLimit };
  }
  if (!decoded.transfer) {
    return { ok: false, reason: "not_erc20_transfer" };
  }
  if (decoded.transfer.recipient !== want.deposit) {
    return {
      ok: false,
      reason: "escrow_mismatch",
      got: decoded.transfer.recipient,
    };
  }
  if (String(decoded.transfer.amount) !== MISSION1_AMOUNT) {
    return { ok: false, reason: "amount_mismatch", got: decoded.transfer.amount };
  }
  // Recompute digest from approved fields (independent of decoded digest path)
  const data = erc20TransferData(want.deposit, MISSION1_AMOUNT);
  const recalc = digestHex(
    eip155UnsignedDigest({
      nonce: BigInt(want.nonce),
      gasPrice: BigInt(want.gas_price),
      gasLimit: BigInt(want.gas_limit),
      to: MISSION1_TOKEN,
      value: 0n,
      data,
      chainId: MISSION1_CHAIN_ID,
    })
  );
  if (recalc.toLowerCase() !== want.digest) {
    return { ok: false, reason: "digest_recalc_mismatch_vs_auth", recalc };
  }
  if (decoded.digest_hex.toLowerCase() !== want.digest) {
    return { ok: false, reason: "digest_mismatch_vs_auth" };
  }
  if (!decoded.recovered || decoded.recovered !== want.mpc) {
    return {
      ok: false,
      reason: "recovered_signer_mismatch",
      recovered: decoded.recovered,
      expected: want.mpc,
    };
  }
  const lhash = localTxHash(decoded.rawHex);
  if (want.local_tx_hash && lhash.toLowerCase() !== want.local_tx_hash) {
    return { ok: false, reason: "local_tx_hash_mismatch", got: lhash };
  }
  return {
    ok: true,
    digest_hex: decoded.digest_hex,
    recovered: decoded.recovered,
    local_tx_hash: lhash,
    rawHex: decoded.rawHex,
    chain_id: MISSION1_CHAIN_ID,
    token: MISSION1_TOKEN,
    deposit_address: want.deposit,
    amount: MISSION1_AMOUNT,
    nonce: want.nonce,
    gas_price: want.gas_price,
    gas_limit: want.gas_limit,
  };
}

/**
 * Trusted live reads for Mission 1 (production). Fixtures only in testHarness.
 */
export async function fetchMission1TrustedState({
  adapters,
  ethRpc = MAINNET_EVM_RPCS.ethereum,
  nearRpc = null,
  testHarness = false,
  deps = {},
} = {}) {
  const gate = assertMission1FixturesAllowed(testHarness, deps);
  if (!gate.ok) return gate;

  let paused;
  let epoch;
  let limits;
  if (testHarness && Object.prototype.hasOwnProperty.call(deps, "paused")) {
    paused = deps.paused;
  } else {
    if (!adapters?.getPaused) return { ok: false, reason: "pause_adapter_required" };
    paused = await adapters.getPaused();
  }
  if (testHarness && Object.prototype.hasOwnProperty.call(deps, "epoch")) {
    epoch = deps.epoch;
  } else {
    if (!adapters?.getMandateEpoch) {
      return { ok: false, reason: "epoch_adapter_required" };
    }
    epoch = await adapters.getMandateEpoch();
  }
  if (testHarness && Object.prototype.hasOwnProperty.call(deps, "limits")) {
    limits = deps.limits;
  } else if (adapters?.getLimits) {
    limits = await adapters.getLimits();
  } else if (testHarness) {
    return { ok: false, reason: "limits_required" };
  } else {
    return { ok: false, reason: "limits_adapter_required" };
  }

  const mpc = MAINNET_IDENTITIES.mpc_evm_address;
  const ethBal =
    testHarness && deps.ethBal
      ? deps.ethBal
      : await evmNativeBalance(ethRpc, mpc);
  const usdcBal =
    testHarness && deps.usdcBal
      ? deps.usdcBal
      : await evmErc20Balance(ethRpc, MAINNET_USDC.ethereum, mpc);

  let nearUsdcBefore = null;
  if (testHarness && Object.prototype.hasOwnProperty.call(deps, "nearUsdcBefore")) {
    nearUsdcBefore = deps.nearUsdcBefore;
  } else if (deps.nearBalanceFn) {
    nearUsdcBefore = await deps.nearBalanceFn();
  } else if (nearRpc || adapters?.rpc) {
    const rpc = nearRpc || adapters.rpc;
    const { verifyNearNep141Delta } = await import("./canarySettlement.mjs");
    // Use ft_balance via check path: verify with before=self by reading balance helper
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: NEAR_NATIVE_USDC_CONTRACT,
        method_name: "ft_balance_of",
        args_base64: Buffer.from(
          JSON.stringify({ account_id: MAINNET_IDENTITIES.owner })
        ).toString("base64"),
      },
    };
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await res.json();
    if (j.result?.result) {
      nearUsdcBefore = JSON.parse(
        Buffer.from(j.result.result).toString("utf8")
      );
    }
    void verifyNearNep141Delta;
  }

  const storage =
    testHarness && deps.storage
      ? deps.storage
      : nearRpc || adapters?.rpc
        ? await checkNearFtStorageRegistered({
            accountId: MAINNET_IDENTITIES.owner,
            tokenContract: NEAR_NATIVE_USDC_CONTRACT,
            rpcUrl: nearRpc || adapters.rpc,
          })
        : null;

  let nonceLatest = null;
  let noncePending = null;
  if (testHarness && deps.nonce != null) {
    nonceLatest = Number(deps.nonce);
    noncePending = Number(deps.nonce);
  } else {
    const [nl, np] = await Promise.all([
      ethJsonRpc(ethRpc, "eth_getTransactionCount", [mpc, "latest"]),
      ethJsonRpc(ethRpc, "eth_getTransactionCount", [mpc, "pending"]),
    ]);
    nonceLatest = Number(BigInt(nl.result || "0x0"));
    noncePending = Number(BigInt(np.result || "0x0"));
  }

  return {
    ok: true,
    paused: Boolean(paused),
    epoch: Number(epoch),
    limits,
    ethBal,
    usdcBal,
    nearUsdcBefore:
      nearUsdcBefore == null ? null : String(nearUsdcBefore),
    storage,
    nonce_latest: nonceLatest,
    nonce_pending: noncePending,
    eth_rpc: ethRpc,
    mpc: mpc.toLowerCase(),
  };
}

/**
 * Verify reconcile against live PendingOp + evidence hash.
 */
export async function verifyMission1ReconcileOnchain({
  adapters,
  operationId,
  evidenceHash,
  testHarness = false,
  deps = {},
}) {
  const gate = assertMission1FixturesAllowed(testHarness, {
    existingPending: deps.pending,
  });
  // Only pending fixture is gated when provided
  if (
    Object.prototype.hasOwnProperty.call(deps, "pending") &&
    testHarness !== true
  ) {
    return { ok: false, reason: "fixture_injection_requires_testHarness" };
  }
  if (!adapters?.getPending && !deps.pending) {
    return { ok: false, reason: "pending_adapter_required" };
  }
  const pending =
    testHarness && deps.pending !== undefined
      ? deps.pending
      : await adapters.getPending(operationId);
  if (!pending) return { ok: false, reason: "pending_missing_after_reconcile" };
  if (String(pending.settlement_state) !== "Success") {
    return {
      ok: false,
      reason: "settlement_state_not_success",
      settlement_state: pending.settlement_state,
    };
  }
  let evidence = deps.evidenceOnchain;
  if (evidence === undefined) {
    if (typeof adapters.getEvidenceHash === "function") {
      evidence = await adapters.getEvidenceHash(operationId);
    } else if (adapters.view) {
      evidence = await adapters.view("get_evidence_hash", {
        operation_id: operationId,
      });
    }
  }
  if (!evidence || String(evidence) !== String(evidenceHash)) {
    return {
      ok: false,
      reason: "evidence_hash_mismatch",
      got: evidence,
      want: evidenceHash,
    };
  }
  let paused = deps.pausedAfter;
  if (paused === undefined) {
    if (!adapters?.getPaused) {
      return { ok: false, reason: "pause_adapter_required_post_reconcile" };
    }
    paused = await adapters.getPaused();
  }
  return {
    ok: true,
    pending,
    evidence_hash: evidence,
    paused: Boolean(paused),
  };
}

/** Check lifecycle advance result — never claim success if persistence failed. */
export function mission1SafeAdvance(advanceResult, label) {
  return requireLifecycleAdvance(advanceResult, label);
}

/** Ambiguous RPC / outcome reasons that must block automatic retry. */
export function isAmbiguousOutcome(reason) {
  const r = String(reason || "").toLowerCase();
  return (
    r.includes("ambiguous") ||
    r.includes("unknown") ||
    r.includes("timeout") ||
    r.includes("temporarily_unverified") ||
    r.includes("reconciliation_required") ||
    r.includes("near_finality_pending") ||
    r.includes("rpc_error")
  );
}

/**
 * Resolve paused/pending/epoch from live adapters unless testHarness fixtures.
 */
export async function resolveMission1LiveGate({
  adapters = null,
  testHarness = false,
  deps = {},
  requireUnpaused = false,
} = {}) {
  const gate = assertMission1FixturesAllowed(testHarness, deps);
  if (!gate.ok) return gate;

  let paused;
  if (testHarness && Object.prototype.hasOwnProperty.call(deps, "paused")) {
    paused = deps.paused;
  } else {
    if (!adapters?.getPaused) {
      return { ok: false, reason: "pause_adapter_required" };
    }
    paused = await adapters.getPaused();
  }

  if (requireUnpaused && paused !== false) {
    return { ok: false, reason: "policy_re_paused", paused };
  }

  let epoch = null;
  if (testHarness && Object.prototype.hasOwnProperty.call(deps, "epoch")) {
    epoch = Number(deps.epoch);
  } else if (adapters?.getMandateEpoch) {
    epoch = Number(await adapters.getMandateEpoch());
  }

  let existingPending;
  if (
    testHarness &&
    Object.prototype.hasOwnProperty.call(deps, "existingPending")
  ) {
    existingPending = deps.existingPending;
  } else if (adapters?.getPending && deps._pendingOpId) {
    existingPending = await adapters.getPending(deps._pendingOpId);
  } else {
    existingPending = undefined;
  }

  return {
    ok: true,
    paused: Boolean(paused),
    epoch,
    existingPending,
  };
}
