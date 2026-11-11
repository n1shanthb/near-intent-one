/**
 * Post-MPC settlement helpers — broadcast, confirm, settle, reconcile.
 * Never re-signs. MPC signature ≠ settlement success.
 * Journal is authoritative for signed bytes + broadcast recovery.
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { hexToBytes } from "@noble/curves/abstract/utils";
import {
  serializeSignedTx,
  erc20TransferData,
  eip155UnsignedDigest,
} from "../intents-codec/quote-auth.mjs";
import { evmAddressFromPubkey } from "../intents-codec/eip191.mjs";
import {
  CHAIN_ID,
  USDC_SEPOLIA,
  DEFAULT_GAS_LIMIT,
} from "./constants.mjs";
import { LIFECYCLE } from "./lifecycle.mjs";
import { SEPOLIA_TIDEPOOL, assertProfileIsolation } from "../execution/chainProfiles.mjs";
import {
  broadcastWithJournal,
  journalIdForExec,
} from "../execution/durableBroadcast.mjs";

export function extractMpcSigFromNearTx(fullTx) {
  const out = { found: false, signature_json: null };
  for (const r of fullTx?.result?.receipts_outcome || []) {
    const sv = r?.outcome?.status?.SuccessValue;
    if (!sv) continue;
    try {
      const decoded = Buffer.from(sv, "base64").toString("utf8");
      if (decoded.includes("Secp256k1") || decoded.includes("big_r")) {
        out.found = true;
        out.signature_json = JSON.parse(decoded);
      }
    } catch {
      /* */
    }
  }
  return out;
}

export function mpcToRsV(sig) {
  const rPoint = hexToBytes(sig.big_r.affine_point);
  const r = rPoint.slice(1);
  const s = hexToBytes(sig.s.scalar);
  let recoveryId = Number(sig.recovery_id);
  if (recoveryId === 27 || recoveryId === 28) recoveryId -= 27;
  return { r, s, recoveryId };
}

export function recoverFromHash(hash, r, s, recoveryId) {
  const compact = new Uint8Array(64);
  compact.set(r, 0);
  compact.set(s, 32);
  const pub = secp256k1.Signature.fromCompact(compact)
    .addRecoveryBit(recoveryId)
    .recoverPublicKey(hash);
  return evmAddressFromPubkey(pub.toRawBytes(false));
}

export async function waitEthReceipt(eth, txHash, { tries = 40, delayMs = 3000 } = {}) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    const j = await eth("eth_getTransactionReceipt", [txHash]);
    if (j.result) return j.result;
  }
  return null;
}

/**
 * Build + optionally broadcast signed ERC-20 transfer from stored MPC execution.
 * @param {object} deps { eth, nearRpc, rpcUrl, agentAccount, journal?, profile? }
 * @param {object} exec store execution with sign_tx, nonce, gas_price, amount, to, …
 * @param {object} portfolio
 * @param {{ dryRun?: boolean, workerId?: string }} opts — dryRun=true never broadcasts
 */
export async function advanceBroadcast(deps, { exec, portfolio }, opts = {}) {
  const { eth, nearRpc, rpcUrl, agentAccount, journal } = deps;
  const profile = deps.profile || SEPOLIA_TIDEPOOL;
  const dryRun = opts.dryRun === true;
  const chainId = Number(exec.chain_id || profile.evm_chain_id);
  const token = String(exec.token_contract || profile.token_usdc).toLowerCase();

  if (profile.network === "mainnet" && !journal) {
    return {
      ok: false,
      reason: "journal_required_for_mainnet_funded",
      status: LIFECYCLE.FAILED,
      may_resign: false,
      retryable: false,
    };
  }

  try {
    assertProfileIsolation(profile, {
      chainId,
      token,
      settleBase: profile.settle_api_base,
    });
  } catch (e) {
    return {
      ok: false,
      status: LIFECYCLE.FAILED,
      reason: String(e.message || e),
      retryable: false,
    };
  }

  if (exec.sepolia_tx || exec.broadcast_hash) {
    return {
      ok: true,
      skipped: true,
      status: LIFECYCLE.BROADCAST,
      sepolia_tx: exec.sepolia_tx || exec.broadcast_hash,
      broadcast_hash: exec.broadcast_hash || exec.sepolia_tx,
      note: "already_broadcast_no_resign",
      may_resign: false,
    };
  }

  const jid = journalIdForExec(exec);
  if (journal) {
    const existing = journal.getByIdempotency(execKeyIdem(exec)) || journal.get(jid);
    if (existing?.signed_raw_enc && existing?.broadcast_hash) {
      return {
        ok: true,
        skipped: true,
        status: LIFECYCLE.BROADCAST,
        sepolia_tx: existing.broadcast_hash,
        broadcast_hash: existing.broadcast_hash,
        local_tx_hash: existing.local_tx_hash,
        journal_id: existing.id,
        may_resign: false,
        note: "journal_already_broadcast",
      };
    }
  }

  let raw = journal?.loadSignedRaw?.(jid) || null;

  if (!raw) {
    if (!exec.sign_tx) {
      return {
        ok: false,
        status: LIFECYCLE.MPC_SIGNED,
        reason: "missing_sign_tx_and_journal_bytes",
        retryable: false,
        may_resign: false,
      };
    }
    const full = await nearRpc(rpcUrl, "EXPERIMENTAL_tx_status", [
      exec.sign_tx,
      agentAccount || portfolio.agent_account,
    ]);
    const extracted = extractMpcSigFromNearTx(full);
    if (!extracted.found) {
      return {
        ok: false,
        status: LIFECYCLE.MPC_SIGNED,
        reason: "MPC_SIG_NOT_FOUND",
        retryable: true,
        may_resign: false,
      };
    }

    const amount = String(exec.amount);
    const deposit = String(exec.to).toLowerCase();
    const nonce = BigInt(exec.nonce);
    const gasPrice = BigInt(exec.gas_price);
    const gasLimit = BigInt(exec.gas_limit || DEFAULT_GAS_LIMIT);
    const data = erc20TransferData(deposit, BigInt(amount));
    const digest = eip155UnsignedDigest({
      nonce,
      gasPrice,
      gasLimit,
      to: token,
      data,
      chainId,
    });

    let { r, s, recoveryId } = mpcToRsV(extracted.signature_json);
    let recovered = recoverFromHash(digest, r, s, recoveryId);
    const expected = String(portfolio.intents_signer_id).toLowerCase();
    if (recovered.toLowerCase() !== expected) {
      const alt = recoveryId ^ 1;
      if (recoverFromHash(digest, r, s, alt).toLowerCase() === expected) {
        recoveryId = alt;
        recovered = expected;
      }
    }
    if (recovered.toLowerCase() !== expected) {
      return {
        ok: false,
        status: LIFECYCLE.FAILED,
        reason: "RECOVERED_ADDRESS_MISMATCH",
        retryable: false,
        recovered,
        expected,
        may_resign: false,
      };
    }

    raw = serializeSignedTx({
      nonce,
      gasPrice,
      gasLimit,
      to: token,
      data,
      chainId,
      r,
      s,
      recoveryId,
    });
  }

  // Persist signed bytes in journal BEFORE any network broadcast.
  if (journal) {
    const idem = execKeyIdem(exec);
    let row = journal.get(jid) || journal.getByIdempotency(idem);
    if (!row) {
      journal.insertDraft({
        id: jid,
        portfolio_id: portfolio.portfolio_id || exec.portfolio_id,
        idempotency_key: idem,
        nonce: String(exec.nonce),
        chain_id: String(chainId),
        meta: {
          operation_id: exec.operation_id,
          owner_account: portfolio.owner_account,
          policy_epoch: exec.policy_epoch || null,
          quote_hash: exec.quote_hash || null,
          profile: profile.id,
          token,
          to: exec.to,
          amount: exec.amount,
          sign_tx: exec.sign_tx,
        },
      });
    }
    let cur = journal.get(jid) || journal.getByIdempotency(idem);
    if (!cur) {
      return { ok: false, reason: "journal_row_missing", status: LIFECYCLE.FAILED };
    }
    if (cur.state === "DRAFT" || !cur.signed_raw_enc) {
      journal.markSigned(cur.id, {
        signedRawHex: raw,
        meta: JSON.parse(cur.meta_json || "{}"),
      });
      cur = journal.get(cur.id);
    }

    const br = await broadcastWithJournal({
      journal,
      journalId: cur.id,
      signedRawHex: raw,
      profile,
      eth,
      opts: {
        dryRun,
        workerId: opts.workerId,
        chainId,
        token,
        depositBound: opts.depositBound,
      },
    });

    if (br.dry_run) {
      return {
        ok: true,
        dry_run: true,
        status: LIFECYCLE.MPC_SIGNED,
        raw_tx_len: raw.length,
        local_tx_hash: br.local_tx_hash,
        journal_id: cur.id,
        may_resign: false,
        note: br.note || "broadcast_suppressed_dry_run",
      };
    }
    if (!br.ok) {
      return {
        ok: false,
        status:
          br.status === "UNKNOWN"
            ? LIFECYCLE.MPC_SIGNED
            : br.reason === "RECOVERED_ADDRESS_MISMATCH"
              ? LIFECYCLE.FAILED
              : LIFECYCLE.MPC_SIGNED,
        reason: br.reason,
        retryable: br.retryable !== false,
        may_resign: false,
        journal_id: cur.id,
        local_tx_hash: br.local_tx_hash,
        error: br.error || null,
      };
    }
    return {
      ok: true,
      status: LIFECYCLE.BROADCAST,
      sepolia_tx: br.broadcast_hash,
      broadcast_hash: br.broadcast_hash,
      explorer: br.explorer,
      deposit_address: String(exec.to).toLowerCase(),
      amount: String(exec.amount),
      journal_id: cur.id,
      local_tx_hash: br.local_tx_hash,
      may_resign: false,
      profile: profile.id,
    };
  }

  // Legacy path without journal — blocked for mainnet; allowed for testnet dry-run only.
  if (profile.network === "mainnet") {
    return {
      ok: false,
      reason: "journal_required_for_mainnet_funded",
      status: LIFECYCLE.FAILED,
      may_resign: false,
    };
  }
  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      status: LIFECYCLE.MPC_SIGNED,
      raw_tx_len: raw.length,
      may_resign: false,
      note: "broadcast_suppressed_dry_run_no_journal",
    };
  }
  return {
    ok: false,
    reason: "journal_required_before_live_broadcast",
    status: LIFECYCLE.MPC_SIGNED,
    may_resign: false,
    note: "Refusing live broadcast without durable journal",
  };
}

function execKeyIdem(exec) {
  return (
    exec.idempotency_key ||
    `gate_k:${exec.portfolio_id}:${exec.operation_id || exec.sign_tx || exec.nonce}`
  );
}

export async function advanceConfirm(deps, { exec }) {
  const { eth, journal } = deps;
  const txHash = exec.sepolia_tx || exec.broadcast_hash;
  if (!txHash) {
    return { ok: false, reason: "NO_SEPOLIA_TX", status: LIFECYCLE.MPC_SIGNED };
  }
  if (exec.receipt_status === "0x1") {
    return {
      ok: true,
      status: LIFECYCLE.CONFIRMED,
      sepolia_tx: txHash,
      skipped: true,
    };
  }
  const receipt = await waitEthReceipt(eth, txHash, {
    tries: 3,
    delayMs: 2000,
  });
  if (!receipt) {
    return {
      ok: false,
      retryable: true,
      status: LIFECYCLE.BROADCAST,
      reason: "RECEIPT_PENDING",
      sepolia_tx: txHash,
    };
  }
  const jid = exec.journal_id || journalIdForExec(exec);
  if (receipt.status !== "0x1") {
    if (journal?.get?.(jid)) {
      try {
        journal.markConfirmed(jid, {
          ...receipt,
          independently_verified: true,
          status: receipt.status,
        });
      } catch {
        journal.markFailed?.(jid, "RECEIPT_REVERTED");
      }
    }
    return {
      ok: false,
      retryable: false,
      status: LIFECYCLE.FAILED,
      reason: "RECEIPT_REVERTED",
      receipt_status: receipt.status,
    };
  }
  if (journal?.get?.(jid)) {
    journal.markConfirmed(jid, {
      ...receipt,
      independently_verified: true,
      status: "0x1",
      transactionHash: txHash,
    });
  }
  return {
    ok: true,
    status: LIFECYCLE.CONFIRMED,
    sepolia_tx: txHash,
    receipt_status: "0x1",
    journal_id: jid,
  };
}
