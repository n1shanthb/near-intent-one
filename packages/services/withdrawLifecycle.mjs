/**
 * Owner withdrawal lifecycle (testnet).
 * Server never holds owner keys. Chat 2 / Ledger signs owner_request_withdraw_signature.
 * Tracks: PREPARED → OWNER_SIGNED → MPC_SIGNED → BROADCAST → CONFIRMED → RECONCILED / FAILED
 */
import { randomBytes } from "node:crypto";
import { DEMO_PREFIX, USDC_SEPOLIA } from "../../scripts/lib/near-live.mjs";
import { LIFECYCLE } from "../gate-k/lifecycle.mjs";

export const WITHDRAW_STATUS = Object.freeze({
  PREPARED: "PREPARED",
  AWAITING_OWNER_SIGNATURE: "AWAITING_OWNER_SIGNATURE",
  OWNER_SUBMITTED: "OWNER_SUBMITTED",
  MPC_SIGNED: "MPC_SIGNED",
  BROADCAST: "BROADCAST",
  CONFIRMED: "CONFIRMED",
  RECONCILED: "RECONCILED",
  FAILED: "FAILED",
  BLOCKED: "BLOCKED",
});

export function createWithdrawLifecycle({ store }) {
  function prepare({
    portfolio,
    owner_account,
    destination,
    amount,
    session_id,
  }) {
    if (String(portfolio.owner_account) !== String(owner_account)) {
      return { ok: false, reason: "owner_mismatch" };
    }
    if (String(owner_account).startsWith(DEMO_PREFIX)) {
      return { ok: false, reason: "demo_owner_forbidden" };
    }
    const withdraw_id = `wd-${randomBytes(8).toString("hex")}`;
    const operation_id = `owner-wd-${Date.now()}`;
    const prepared = {
      withdraw_id,
      kind: "owner_withdraw",
      status: WITHDRAW_STATUS.AWAITING_OWNER_SIGNATURE,
      portfolio_id: portfolio.portfolio_id,
      owner_account,
      session_id: session_id || null,
      policy_contract: portfolio.policy_contract,
      intents_signer_id: portfolio.intents_signer_id,
      destination: String(destination).toLowerCase(),
      amount: String(amount),
      token_contract: USDC_SEPOLIA.toLowerCase(),
      chain_id: "11155111",
      operation_id,
      method: "owner_request_withdraw_signature",
      created_at: new Date().toISOString(),
      note: "Owner must Ledger/wallet-sign owner_request_withdraw_signature. ECDSA export is not recalled by mandate revoke.",
    };

    store.update((s) => {
      s.withdrawals = s.withdrawals || {};
      s.withdrawals[withdraw_id] = prepared;
      return s;
    });

    return {
      ok: true,
      status: WITHDRAW_STATUS.AWAITING_OWNER_SIGNATURE,
      withdraw: prepared,
      near_function_call: {
        receiver_id: portfolio.policy_contract,
        method_name: "owner_request_withdraw_signature",
        args_template: {
          operation_id,
          withdraw: {
            // nonce/gas filled by client from live eth_getTransactionCount / eth_gasPrice
            token_contract: USDC_SEPOLIA.toLowerCase(),
            to: String(destination).toLowerCase(),
            amount: String(amount),
            chain_id: "11155111",
            gas_limit: "100000",
          },
        },
      },
    };
  }

  function attachOwnerTx({ withdraw_id, owner_account, near_tx_hash }) {
    const w = store.read().withdrawals?.[withdraw_id];
    if (!w) return { ok: false, reason: "not_found" };
    if (String(w.owner_account) !== String(owner_account)) {
      return { ok: false, reason: "owner_mismatch" };
    }
    if (!near_tx_hash || String(near_tx_hash).length < 16) {
      return { ok: false, reason: "invalid_near_tx_hash" };
    }
    if (
      w.status !== WITHDRAW_STATUS.AWAITING_OWNER_SIGNATURE &&
      w.status !== WITHDRAW_STATUS.PREPARED
    ) {
      if (w.near_tx_hash === near_tx_hash) {
        return { ok: true, idempotent: true, withdraw: w };
      }
      return { ok: false, reason: "invalid_status", status: w.status };
    }

    store.update((s) => {
      s.withdrawals[withdraw_id] = {
        ...w,
        status: WITHDRAW_STATUS.OWNER_SUBMITTED,
        near_tx_hash,
        owner_submitted_at: new Date().toISOString(),
      };
      return s;
    });
    return {
      ok: true,
      status: WITHDRAW_STATUS.OWNER_SUBMITTED,
      withdraw: store.read().withdrawals[withdraw_id],
      next_action: "await_mpc_then_settlement_worker",
      note: "MPC signature may still need Sepolia broadcast/reconcile — not settlement yet",
    };
  }

  function get(withdraw_id) {
    return store.read().withdrawals?.[withdraw_id] || null;
  }

  function listForOwner(owner_account) {
    return Object.values(store.read().withdrawals || {}).filter(
      (w) => w.owner_account === owner_account
    );
  }

  return {
    prepare,
    attachOwnerTx,
    get,
    listForOwner,
    statuses: WITHDRAW_STATUS,
    lifecycle_alias: LIFECYCLE,
  };
}
