/**
 * Read-only mainnet public audit/mandate helpers for OCI.
 * No signing. No secrets in responses.
 *
 * Rules:
 * - Normalize every RPC view; never leak `{error}` envelopes to clients.
 * - Unknown ≠ false (autonomy OFF). Use null / data_quality markers.
 * - Prefer fewer sequential reads + fallback RPC + last-good cache.
 * - Never label a cache hit as fresh.
 */
import { join } from "node:path";
import { MAINNET_IDENTITIES } from "../mainnet/identities.mjs";
import {
  listCanonicalRecords,
  loadCanonicalRecord,
  recomputeAndCompare,
  defaultAuditStoreDir,
  AUDIT_STATUS,
} from "../autonomous/decisionAudit.mjs";
import { readFile } from "node:fs/promises";

/** Prefer public near.org first; FastNear free tier rate-limits hard under fan-out. */
const RPCS = [
  process.env.NIO_MAINNET_RPC,
  "https://rpc.mainnet.near.org",
  "https://rpc.mainnet.fastnear.com",
].filter(Boolean);

const CACHE_MS = 25_000;
const LAST_GOOD_MAX_MS = 15 * 60_000;
const BACKOFF_MS = [250, 600, 1200];

let cache = { at: 0, mandate: null, agent: null };
/** Durable last successful full snapshot (may be older than CACHE_MS). */
let lastGood = { at: 0, agent: null, mandate: null };

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

function isRateLimited(err) {
  const msg = JSON.stringify(err || "");
  return /-429/i.test(msg) || /rate limit/i.test(msg) || /-320/i.test(msg);
}

export function isViewError(value) {
  return Boolean(value && typeof value === "object" && "error" in value);
}

export function unwrapView(value, fallback = null) {
  if (value == null || isViewError(value)) return fallback;
  return value;
}

/** Tri-state boolean: true | false | null (UNKNOWN). Never coerce null→false. */
export function asTriBool(value) {
  if (value === true || value === false) return value;
  if (value === "true" || value === 1 || value === "1") return true;
  if (value === "false" || value === 0 || value === "0") return false;
  return null;
}

export async function pickMainnetRpc() {
  for (const u of RPCS) {
    try {
      const j = await rpc(u, "status", []);
      if (!j.error) return u;
    } catch {
      /* next */
    }
  }
  throw new Error("no_mainnet_rpc");
}

export async function viewFn(url, methodName, args = {}) {
  const j = await rpc(url, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: MAINNET_IDENTITIES.policy,
    method_name: methodName,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (j.error || j.result?.error) return { error: j.error || j.result.error };
  const raw = Buffer.from(j.result.result).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Sequential RPC with fallback + short backoff on 429.
 * Never parallel-fan-out against FastNear.
 */
export async function viewFnResilient(methodName, args = {}) {
  let lastErr = null;
  for (const url of RPCS) {
    for (let attempt = 0; attempt < BACKOFF_MS.length; attempt++) {
      try {
        const out = await viewFn(url, methodName, args);
        if (!isViewError(out)) return out;
        lastErr = out.error;
        if (!isRateLimited(out.error)) return out;
        await sleep(BACKOFF_MS[attempt]);
      } catch (e) {
        lastErr = String(e.message || e);
        await sleep(BACKOFF_MS[attempt]);
      }
    }
  }
  return { error: lastErr || "all_rpcs_failed" };
}

export async function viewAccount(url) {
  const j = await rpc(url, "query", {
    request_type: "view_account",
    finality: "final",
    account_id: MAINNET_IDENTITIES.policy,
  });
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}

function normalizeLimits(raw) {
  const limits = isViewError(raw) || !raw || typeof raw !== "object" ? {} : raw;
  return {
    max_trade_value: limits.max_trade_value ?? null,
    daily_turnover_limit: limits.daily_turnover_limit ?? null,
    max_pending_exposure: limits.max_pending_exposure ?? null,
    max_slippage_bps:
      typeof limits.max_slippage_bps === "number"
        ? limits.max_slippage_bps
        : limits.max_slippage_bps != null
          ? Number(limits.max_slippage_bps)
          : null,
    max_gas_budget: limits.max_gas_budget ?? null,
    token_scope: limits.token_scope ?? null,
    allowed_chains: Array.isArray(limits.allowed_chains)
      ? limits.allowed_chains
      : [],
    allowed_assets: Array.isArray(limits.allowed_assets)
      ? limits.allowed_assets
      : [],
    allowed_venues: Array.isArray(limits.allowed_venues)
      ? limits.allowed_venues
      : [],
    allowed_destinations: Array.isArray(limits.allowed_destinations)
      ? limits.allowed_destinations
      : [],
    valid_until: limits.valid_until ?? null,
  };
}

function markStale(snap, reason) {
  if (!snap) return null;
  return {
    ...snap,
    fresh: false,
    stale: true,
    data_quality: "LAST_KNOWN_GOOD",
    cached_at: snap.fetched_at,
    rpc_error: reason,
  };
}

export async function getLiveAgentSnapshot() {
  const now = Date.now();
  if (cache.agent && now - cache.at < CACHE_MS) {
    return {
      ...cache.agent,
      fresh: false,
      cache_age_ms: now - cache.at,
      data_quality: cache.agent.data_quality || "CACHE",
    };
  }

  try {
    const url = await pickMainnetRpc();
    const acct = await viewAccount(url);

    // Minimal sequential reads — gate_j first (composite), then flags, then limits.
    const gj = await viewFnResilient("get_gate_j_mandate");
    const hasGj = !isViewError(gj);

    const paused = unwrapView(
      hasGj && gj.paused != null ? gj.paused : await viewFnResilient("get_paused"),
      null
    );
    const mandate_epoch = unwrapView(
      hasGj && gj.mandate_epoch != null
        ? gj.mandate_epoch
        : await viewFnResilient("get_mandate_epoch"),
      null
    );
    const autonomous_trading = asTriBool(
      await viewFnResilient("get_autonomous_trading")
    );
    const enforce_autonomous_on_agent = asTriBool(
      await viewFnResilient("get_enforce_autonomous_on_agent")
    );
    const state_version = unwrapView(
      await viewFnResilient("get_state_version"),
      null
    );
    const revocation = unwrapView(
      await viewFnResilient("get_revocation_status"),
      null
    );
    const limitsRaw =
      hasGj && gj.limits
        ? gj.limits
        : await viewFnResilient("get_limits");
    const limits = normalizeLimits(limitsRaw);
    const limitsOk =
      Boolean(limits.max_trade_value) && limits.allowed_chains.length > 0;

    const snap = {
      ok: true,
      network: "mainnet",
      fetched_at: new Date().toISOString(),
      fresh: true,
      cache_ttl_ms: CACHE_MS,
      data_quality: limitsOk ? "LIVE" : "PARTIAL",
      identities: {
        owner: MAINNET_IDENTITIES.owner,
        agent: MAINNET_IDENTITIES.agent,
        policy: MAINNET_IDENTITIES.policy,
        portfolio_id: MAINNET_IDENTITIES.portfolio_id,
        mpc_evm: MAINNET_IDENTITIES.mpc_evm_address,
      },
      code_hash: acct.code_hash,
      storage_usage: acct.storage_usage,
      views: {
        owner: MAINNET_IDENTITIES.owner,
        agent: MAINNET_IDENTITIES.agent,
        portfolio_id: MAINNET_IDENTITIES.portfolio_id,
        paused: asTriBool(paused),
        mandate_epoch:
          typeof mandate_epoch === "number"
            ? mandate_epoch
            : mandate_epoch != null
              ? Number(mandate_epoch)
              : null,
        autonomous_trading,
        enforce_autonomous_on_agent,
        state_version:
          typeof state_version === "number" || typeof state_version === "string"
            ? state_version
            : null,
        revocation,
        reserved_pending_exposure: unwrapView(
          hasGj ? gj.reserved_pending_exposure : null,
          "0"
        ),
        intents_signer_id: MAINNET_IDENTITIES.mpc_evm_address,
        derivation_path: MAINNET_IDENTITIES.derivation_path,
        limits,
        daily_turnover: hasGj ? unwrapView(gj.daily_turnover, null) : null,
        realized_exposure: hasGj ? unwrapView(gj.realized_exposure, null) : null,
      },
      provenance: {
        deploy_tx: "7rxXmYqbDL7HyBtG2EKo4g1xHbJYptphg9jMLU7Konrf",
        migrate_tx: "3XHBXDPWMhmDymZdh4NrVZfxYwp9DqcbekLVVrxVSYME",
        activate_tx: "6zQs6C56tdPYz5BYY9Ca2T4XusU5oavt1gDw3tdDaW93",
        unpause_tx: "9jaW3jv5z2adx8aV6xXhfvCstxeKrRaQp2e8SEHX61Fy",
        audit_wasm_tx: "4oM5UGjwk8vtUzJ6cjo6bhY1zWaaGSMtD8c2LDC2Tb3G",
        migrate_v2_tx: "CRUYyjdYMwfKzxpUBvcKXJtn5dvi7CH9zdocUawu2CFj",
        no_trade_audit_tx: "CXR4ey3x2x3scEhGeW8sRLnRAVsPrsYiRYFPcTAAAz1s",
      },
    };
    if (hasGj) snap.gate_j_mandate = gj;

    cache = { at: now, agent: snap, mandate: null };
    if (limitsOk) {
      lastGood = { at: now, agent: snap, mandate: null };
    }
    return snap;
  } catch (e) {
    const reason = String(e.message || e);
    if (lastGood.agent && now - lastGood.at < LAST_GOOD_MAX_MS) {
      const stale = markStale(lastGood.agent, reason);
      cache = { at: now, agent: stale, mandate: null };
      return stale;
    }
    throw e;
  }
}

export async function getLiveMandateSnapshot() {
  const agent = await getLiveAgentSnapshot();
  const limits = normalizeLimits(agent.views.limits);
  const validUntilNs = Number(limits.valid_until || 0);
  const nowMs = Date.now();
  const expiryMs = validUntilNs > 0 ? Math.floor(validUntilNs / 1e6) : null;
  const auto = asTriBool(agent.views.autonomous_trading);
  const enforce = asTriBool(agent.views.enforce_autonomous_on_agent);
  const paused = asTriBool(agent.views.paused);
  const mandate = {
    ok: true,
    network: "mainnet",
    fetched_at: agent.fetched_at,
    fresh: Boolean(agent.fresh) && !agent.stale,
    stale: Boolean(agent.stale),
    data_quality: agent.data_quality || (agent.fresh ? "LIVE" : "CACHE"),
    cached_at: agent.cached_at || null,
    rpc_error: agent.rpc_error || null,
    owner: MAINNET_IDENTITIES.owner,
    agent: MAINNET_IDENTITIES.agent,
    policy: MAINNET_IDENTITIES.policy,
    portfolio_id: MAINNET_IDENTITIES.portfolio_id,
    mandate_epoch: agent.views.mandate_epoch,
    paused,
    revoked:
      agent.views.revocation && !isViewError(agent.views.revocation)
        ? Boolean(agent.views.revocation.revoked)
        : null,
    autonomous_trading: auto,
    enforce_autonomous_on_agent: enforce,
    state_version: agent.views.state_version,
    limits,
    usage: {
      reserved_pending_exposure: String(
        unwrapView(agent.views.reserved_pending_exposure, "0")
      ),
      daily_turnover: unwrapView(agent.views.daily_turnover, null),
      realized_exposure: unwrapView(agent.views.realized_exposure, null),
    },
    expiry: {
      valid_until_ns: limits.valid_until || null,
      expires_at_ms: expiryMs,
      expires_in_ms: expiryMs ? Math.max(0, expiryMs - nowMs) : null,
    },
    labels: {
      permitted_by_policy: true,
      verified_execution: false,
      note: "Allowlists are PERMITTED BY POLICY; settlement requires separate verification",
    },
  };
  if (mandate.fresh && limits.max_trade_value) {
    lastGood = { ...lastGood, at: Date.now(), mandate };
  }
  return mandate;
}

async function loadMeta(cycle_id, storeDir) {
  try {
    return JSON.parse(await readFile(join(storeDir, `${cycle_id}.meta.json`), "utf8"));
  } catch {
    return null;
  }
}

export async function listDecisions(limit = 40) {
  const storeDir = defaultAuditStoreDir();
  const records = await listCanonicalRecords(storeDir, limit);
  const out = [];
  for (const r of records) {
    const meta = (await loadMeta(r.cycle_id, storeDir)) || {
      status: AUDIT_STATUS.OFFCHAIN_ONLY,
    };
    out.push({
      cycle_id: r.cycle_id,
      timestamp_ms: r.timestamp_ms,
      final_action: r.final_action,
      fitter_verdict: r.fitter_verdict,
      critic_verdict: r.critic_verdict,
      reason_code: r.reason_code,
      mandate_epoch: r.mandate_epoch,
      evidence_hash: r.evidence_hash,
      decision_hash: r.decision_hash,
      status: meta.status,
      near_tx: meta.near_tx || null,
      explorer: meta.explorer || null,
      labels: r.labels,
    });
  }
  return { ok: true, count: out.length, decisions: out, store_dir_set: true };
}

export async function getDecision(cycle_id) {
  const storeDir = defaultAuditStoreDir();
  const record = await loadCanonicalRecord(cycle_id, storeDir);
  if (!record) return { ok: false, reason: "not_found", cycle_id };
  const meta = (await loadMeta(cycle_id, storeDir)) || {
    status: AUDIT_STATUS.OFFCHAIN_ONLY,
  };
  const integrity = recomputeAndCompare(record);
  return {
    ok: true,
    record,
    meta,
    integrity,
    explorer: meta.explorer,
  };
}

export async function getProof(cycle_id) {
  const detail = await getDecision(cycle_id);
  if (!detail.ok) return detail;
  let onchain = null;
  try {
    onchain = await viewFnResilient("get_decision_cycle", { cycle_id });
  } catch (e) {
    onchain = { error: String(e.message || e) };
  }
  const chainHash =
    onchain && !isViewError(onchain) ? onchain.evidence_hash : null;
  const match =
    chainHash &&
    detail.record.evidence_hash &&
    chainHash === detail.record.evidence_hash;
  const status = match
    ? AUDIT_STATUS.ONCHAIN_VERIFIED
    : isViewError(onchain) || !chainHash
      ? detail.meta.status || AUDIT_STATUS.OFFCHAIN_ONLY
      : "ONCHAIN_MISMATCH";
  return {
    ok: true,
    cycle_id,
    offchain_evidence_hash: detail.record.evidence_hash,
    recomputed_ok: detail.integrity.ok,
    onchain_lookup: isViewError(onchain) ? null : onchain,
    onchain_error: isViewError(onchain) ? onchain.error : null,
    hash_match: Boolean(match),
    status,
    near_tx: detail.meta.near_tx,
    explorer: detail.meta.explorer,
    status_explain:
      status === AUDIT_STATUS.ONCHAIN_VERIFIED
        ? "On-chain evidence hash matches the off-chain record and verification succeeded."
        : status === "ONCHAIN_MISMATCH"
          ? "An on-chain record exists but the evidence hash does not match."
          : "Decision recorded locally; no matching NEAR receipt was verified.",
    note:
      "Audit receipt ≠ swap settlement. SETTLED only after independent reconcile.",
  };
}

export async function getLiveBalancesSnapshot() {
  const url = await pickMainnetRpc();
  async function nearBalance(account_id) {
    try {
      const j = await rpc(url, "query", {
        request_type: "view_account",
        finality: "final",
        account_id,
      });
      if (j.error)
        return { amount: null, status: "unavailable", note: String(j.error) };
      const yocto = j.result?.amount;
      if (yocto == null) return { amount: null, status: "unavailable" };
      const near = Number(yocto) / 1e24;
      return {
        amount: Number.isFinite(near) ? near.toFixed(4) : String(yocto),
        status: "verified",
        raw_yocto: String(yocto),
      };
    } catch (e) {
      return { amount: null, status: "unavailable", note: String(e.message || e) };
    }
  }
  const owner = await nearBalance(MAINNET_IDENTITIES.owner);
  const agent = await nearBalance(MAINNET_IDENTITIES.agent);
  const policy = await nearBalance(MAINNET_IDENTITIES.policy);
  return {
    ok: true,
    network: "mainnet",
    fetched_at: new Date().toISOString(),
    fresh: true,
    rows: [
      {
        account: MAINNET_IDENTITIES.owner,
        role: "owner",
        chain: "near",
        asset: "NEAR",
        amount: owner.amount,
        status: owner.status,
        note: owner.note,
      },
      {
        account: MAINNET_IDENTITIES.agent,
        role: "agent",
        chain: "near",
        asset: "NEAR",
        amount: agent.amount,
        status: agent.status,
        note: agent.note,
      },
      {
        account: MAINNET_IDENTITIES.policy,
        role: "policy",
        chain: "near",
        asset: "NEAR",
        amount: policy.amount,
        status: policy.status,
        note: policy.note,
      },
      {
        account: MAINNET_IDENTITIES.mpc_evm_address,
        role: "mpc_evm",
        chain: "eip155:1",
        asset: "ETH/USDC",
        amount: null,
        status: "unavailable",
        note: "EVM MPC balances require dedicated RPC reads — not displayed as demo amounts",
      },
    ],
    note: "NEAR native balances verified via mainnet RPC. EVM slices marked unavailable unless independently proven.",
  };
}

export async function listTransactions() {
  return {
    ok: true,
    network: "mainnet",
    governance: [
      {
        kind: "DeployContract",
        tx: "7rxXmYqbDL7HyBtG2EKo4g1xHbJYptphg9jMLU7Konrf",
        explorer:
          "https://nearblocks.io/txns/7rxXmYqbDL7HyBtG2EKo4g1xHbJYptphg9jMLU7Konrf",
        label: "MAINNET",
      },
      {
        kind: "migrate_state_v1_autonomy",
        tx: "3XHBXDPWMhmDymZdh4NrVZfxYwp9DqcbekLVVrxVSYME",
        explorer:
          "https://nearblocks.io/txns/3XHBXDPWMhmDymZdh4NrVZfxYwp9DqcbekLVVrxVSYME",
        label: "MAINNET",
      },
      {
        kind: "activate_autonomous_mandate",
        tx: "6zQs6C56tdPYz5BYY9Ca2T4XusU5oavt1gDw3tdDaW93",
        explorer:
          "https://nearblocks.io/txns/6zQs6C56tdPYz5BYY9Ca2T4XusU5oavt1gDw3tdDaW93",
        label: "MAINNET",
      },
      {
        kind: "unpause",
        tx: "9jaW3jv5z2adx8aV6xXhfvCstxeKrRaQp2e8SEHX61Fy",
        explorer:
          "https://nearblocks.io/txns/9jaW3jv5z2adx8aV6xXhfvCstxeKrRaQp2e8SEHX61Fy",
        label: "MAINNET",
      },
      {
        kind: "DeployContract_audit_wasm",
        tx: "4oM5UGjwk8vtUzJ6cjo6bhY1zWaaGSMtD8c2LDC2Tb3G",
        explorer:
          "https://nearblocks.io/txns/4oM5UGjwk8vtUzJ6cjo6bhY1zWaaGSMtD8c2LDC2Tb3G",
        label: "MAINNET",
      },
      {
        kind: "migrate_state_v2_decision_audit",
        tx: "CRUYyjdYMwfKzxpUBvcKXJtn5dvi7CH9zdocUawu2CFj",
        explorer:
          "https://nearblocks.io/txns/CRUYyjdYMwfKzxpUBvcKXJtn5dvi7CH9zdocUawu2CFj",
        label: "MAINNET",
      },
      {
        kind: "record_decision_cycle_NO_TRADE",
        tx: "CXR4ey3x2x3scEhGeW8sRLnRAVsPrsYiRYFPcTAAAz1s",
        explorer:
          "https://nearblocks.io/txns/CXR4ey3x2x3scEhGeW8sRLnRAVsPrsYiRYFPcTAAAz1s",
        label: "MAINNET",
      },
    ],
    supervised_canaries_note:
      "Prior j8b/m1/m2 canaries were SUPERVISED — not autonomous mainnet trades",
    autonomous_settled_trades: [],
  };
}
