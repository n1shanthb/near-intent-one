/**
 * Journal-backed broadcast: persist identical signed bytes BEFORE eth_sendRawTransaction.
 * Never re-signs. Mainnet funded path refuses without durable journal.
 */
import { localTxHash, TX_STATE } from "./txJournal.mjs";
import {
  assertProfileIsolation,
  assertMainnetFundedAllowed,
  CHAIN_PROFILE,
} from "./chainProfiles.mjs";
import { assertMainnetBroadcastAllowed } from "../mainnet/safetyGates.mjs";

/**
 * @param {object} args
 * @param {import('./txJournal.mjs').openTxJournal extends Function ? any : any} args.journal
 * @param {string} args.journalId
 * @param {string} args.signedRawHex
 * @param {object} args.profile
 * @param {(method:string,params:any[])=>Promise<any>} args.eth
 * @param {{ dryRun?: boolean, workerId?: string, depositBound?: object }} [args.opts]
 */
export async function broadcastWithJournal({
  journal,
  journalId,
  signedRawHex,
  profile,
  eth,
  opts = {},
}) {
  if (!journal) {
    if (profile?.id === CHAIN_PROFILE.MAINNET_1CLICK) {
      return { ok: false, reason: "journal_required_for_mainnet_funded" };
    }
    return { ok: false, reason: "journal_required" };
  }
  try {
    journal.assertWritable();
  } catch (e) {
    return { ok: false, reason: "journal_unwritable", detail: String(e.message || e) };
  }

  const fundedGate = assertMainnetFundedAllowed(profile, {
    journal,
    depositBound: opts.depositBound,
  });
  if (profile?.id === CHAIN_PROFILE.MAINNET_1CLICK && !fundedGate.ok) {
    return { ok: false, ...fundedGate };
  }

  assertProfileIsolation(profile, {
    chainId: opts.chainId ?? profile.evm_chain_id,
    token: opts.token,
  });

  const workerId = opts.workerId || `worker-${process.pid}`;
  const claim = journal.tryClaim(journalId, workerId);
  if (!claim.ok) return { ok: false, ...claim };

  try {
    const cur = journal.get(journalId);
    if (!cur) return { ok: false, reason: "unknown_journal_id" };

    // Already broadcast — reconcile chain, never resign.
    if (cur.broadcast_hash && [TX_STATE.BROADCAST, TX_STATE.CONFIRMED, TX_STATE.SETTLEMENT_PENDING, TX_STATE.SETTLED, TX_STATE.RECONCILED].includes(cur.state)) {
      return {
        ok: true,
        skipped: true,
        status: cur.state,
        broadcast_hash: cur.broadcast_hash,
        local_tx_hash: cur.local_tx_hash,
        may_resign: false,
        note: "already_broadcast_journal_authority",
      };
    }

    if (cur.state === TX_STATE.REVOKED_AFTER_SIGN) {
      return {
        ok: false,
        reason: "revoked_after_sign_residual_risk",
        may_resign: false,
        may_rebroadcast_identical: true,
        note: "Exported ECDSA may still execute; operator cancel path required",
        local_tx_hash: cur.local_tx_hash,
      };
    }

    let raw = signedRawHex || journal.loadSignedRaw(journalId);
    if (!raw) return { ok: false, reason: "signed_bytes_missing" };

    const hash = localTxHash(raw);
    if (cur.state === TX_STATE.DRAFT) {
      journal.markSigned(journalId, {
        signedRawHex: raw,
        meta: { ...(JSON.parse(cur.meta_json || "{}")), local_tx_hash: hash },
      });
    } else if (cur.state === TX_STATE.SIGNED || cur.state === TX_STATE.BROADCAST_PENDING) {
      const existing = journal.loadSignedRaw(journalId);
      if (existing && existing.toLowerCase() !== raw.toLowerCase()) {
        return { ok: false, reason: "signed_bytes_mismatch_no_resign" };
      }
      raw = existing || raw;
    }

    if (opts.dryRun) {
      return {
        ok: true,
        dry_run: true,
        status: TX_STATE.SIGNED,
        local_tx_hash: hash,
        may_resign: false,
        note: "broadcast_suppressed_dry_run_journal_has_bytes",
      };
    }

    // Global mainnet gate — blocks ALL submission, not only 1Click-specific paths.
    if (profile?.network === "mainnet" || profile?.id === CHAIN_PROFILE.MAINNET_1CLICK) {
      const gate = assertMainnetBroadcastAllowed(opts.env || process.env);
      if (!gate.ok) {
        return {
          ok: false,
          submitted: false,
          reason: gate.reason,
          gates: gate.gates,
          may_resign: false,
          local_tx_hash: hash,
          note: "mainnet_broadcast_hard_blocked",
        };
      }
    }

    journal.beginBroadcast(journalId);

    let send;
    try {
      send = await eth("eth_sendRawTransaction", [raw.startsWith("0x") ? raw : `0x${raw}`]);
    } catch (e) {
      journal.markUnknown(journalId, { rpc_error: String(e.message || e).slice(0, 200) });
      return {
        ok: false,
        reason: "broadcast_rpc_timeout_or_error",
        retryable: true,
        may_resign: false,
        local_tx_hash: hash,
        status: TX_STATE.UNKNOWN,
      };
    }

    if (send?.error || !send?.result) {
      // Ambiguous: might have been accepted — mark UNKNOWN for chain reconcile
      const msg = String(send?.error?.message || send?.error || "broadcast_failed");
      if (/already known|nonce too low|replacement/i.test(msg)) {
        journal.markUnknown(journalId, { rpc: msg });
        return {
          ok: false,
          reason: "broadcast_ambiguous_reconcile_chain",
          retryable: true,
          may_resign: false,
          local_tx_hash: hash,
          status: TX_STATE.UNKNOWN,
        };
      }
      // Clear failure before accept — roll back to SIGNED for identical retry
      const rolled = journal.get(journalId);
      if (rolled?.state === TX_STATE.BROADCAST_PENDING) {
        journal.db
          .prepare(`UPDATE tx_journal SET state = ?, updated_at = ? WHERE id = ?`)
          .run(TX_STATE.SIGNED, new Date().toISOString(), journalId);
      }
      return {
        ok: false,
        reason: "BROADCAST_FAILED",
        retryable: true,
        may_resign: false,
        error: send?.error || null,
        local_tx_hash: hash,
      };
    }

    const broadcastHash = send.result;
    journal.markBroadcast(journalId, broadcastHash);
    return {
      ok: true,
      status: TX_STATE.BROADCAST,
      broadcast_hash: broadcastHash,
      local_tx_hash: hash,
      explorer: profile.explorer_tx?.(broadcastHash) || null,
      may_resign: false,
      identical_bytes: true,
    };
  } finally {
    journal.releaseClaim(journalId, workerId);
  }
}

export function journalIdForExec(exec) {
  return (
    exec?.journal_id ||
    exec?.operation_id ||
    exec?.key ||
    `op:${exec?.portfolio_id}:${exec?.nonce}:${exec?.sign_tx || "pending"}`
  );
}
