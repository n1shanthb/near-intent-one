/**
 * Read-only mainnet public audit/mandate helpers for OCI.
 * No signing. No secrets in responses.
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

const RPCS = [
  process.env.NIO_MAINNET_RPC,
  "https://rpc.mainnet.fastnear.com",
  "https://rpc.mainnet.near.org",
].filter(Boolean);

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
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

/** True when a view result is an RPC/contract error envelope — never render these in React. */
export function isViewError(value) {
  return Boolean(value && typeof value === "object" && "error" in value);
}

/** Unwrap a view result to a scalar/object, or `fallback` when the RPC failed. */
export function unwrapView(value, fallback = null) {
  if (value == null || isViewError(value)) return fallback;
  return value;
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

/** Prefer a healthy RPC; on rate-limit / failure, try the next endpoint. */
export async function viewFnResilient(methodName, args = {}) {
  let lastErr = null;
  for (const url of RPCS) {
    try {
      const out = await viewFn(url, methodName, args);
      if (!isViewError(out)) return out;
      lastErr = out.error;
      const msg = JSON.stringify(out.error || "");
      if (!/-320/i.test(msg) && !/rate limit/i.test(msg) && !/-429/i.test(msg)) {
        return out;
      }
    } catch (e) {
      lastErr = String(e.message || e);
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

let cache = { at: 0, mandate: null, agent: null };
const CACHE_MS = 20_000;

export async function getLiveAgentSnapshot() {
  const now = Date.now();
  if (cache.agent && now - cache.at < CACHE_MS) {
    return { ...cache.agent, cache_age_ms: now - cache.at, fresh: false };
  }
  let url;
  try {
    url = await pickMainnetRpc();
  } catch (e) {
    if (cache.agent) {
      return {
        ...cache.agent,
        fresh: false,
        stale: true,
        rpc_error: String(e.message || e),
      };
    }
    throw e;
  }
  let acct;
  try {
    acct = await viewAccount(url);
  } catch (e) {
    if (cache.agent) {
      return {
        ...cache.agent,
        fresh: false,
        stale: true,
        rpc_error: String(e.message || e),
      };
    }
    throw e;
  }

  // Prefer composite + a few critical views. Never fan out 12+ sequential RPC calls
  // (FastNear free tier returns -429 and {error} envelopes that crash React if rendered).
  const gj = await viewFnResilient("get_gate_j_mandate");
  const hasGj = !isViewError(gj);
  const prior = cache.agent?.views || {};

  const [pausedV, epochV, autoV, enforceV, stateV, revocationV, limitsV] =
    await Promise.all([
      hasGj && gj.paused != null
        ? Promise.resolve(gj.paused)
        : viewFnResilient("get_paused"),
      hasGj && gj.mandate_epoch != null
        ? Promise.resolve(gj.mandate_epoch)
        : viewFnResilient("get_mandate_epoch"),
      viewFnResilient("get_autonomous_trading"),
      viewFnResilient("get_enforce_autonomous_on_agent"),
      viewFnResilient("get_state_version"),
      viewFnResilient("get_revocation_status"),
      hasGj && gj.limits
        ? Promise.resolve(gj.limits)
        : viewFnResilient("get_limits"),
    ]);

  const owner = MAINNET_IDENTITIES.owner;
  const agent = MAINNET_IDENTITIES.agent;
  const portfolio_id = MAINNET_IDENTITIES.portfolio_id;
  const paused = unwrapView(pausedV, unwrapView(prior.paused, null));
  const mandate_epoch = unwrapView(
    epochV,
    unwrapView(prior.mandate_epoch, null)
  );
  const autonomous_trading = unwrapView(
    autoV,
    unwrapView(prior.autonomous_trading, null)
  );
  const enforce_autonomous_on_agent = unwrapView(
    enforceV,
    unwrapView(prior.enforce_autonomous_on_agent, null)
  );
  const state_version = unwrapView(stateV, unwrapView(prior.state_version, null));
  const revocation = unwrapView(revocationV, unwrapView(prior.revocation, null));
  const reserved_pending_exposure = unwrapView(
    hasGj && gj.reserved_pending_exposure != null
      ? gj.reserved_pending_exposure
      : prior.reserved_pending_exposure,
    "0"
  );
  const intents_signer_id = MAINNET_IDENTITIES.mpc_evm_address;
  const derivation_path = MAINNET_IDENTITIES.derivation_path;
  const limits = unwrapView(limitsV, unwrapView(prior.limits, {}));

  const snap = {
    ok: true,
    network: "mainnet",
    fetched_at: new Date().toISOString(),
    fresh: true,
    cache_ttl_ms: CACHE_MS,
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
      owner,
      agent,
      portfolio_id,
      paused,
      mandate_epoch,
      autonomous_trading,
      enforce_autonomous_on_agent,
      state_version,
      revocation,
      reserved_pending_exposure,
      intents_signer_id,
      derivation_path,
      limits: limits && typeof limits === "object" ? limits : {},
      daily_turnover: hasGj ? unwrapView(gj.daily_turnover, null) : null,
      realized_exposure: hasGj ? unwrapView(gj.realized_exposure, null) : null,
    },
    provenance: {
      deploy_tx: "7rxXmYqbDL7HyBtG2EKo4g1xHbJYptphg9jMLU7Konrf",
      migrate_tx: "3XHBXDPWMhmDymZdh4NrVZfxYwp9DqcbekLVVrxVSYME",
      activate_tx: "6zQs6C56tdPYz5BYY9Ca2T4XusU5oavt1gDw3tdDaW93",
      unpause_tx: "9jaW3jv5z2adx8aV6xXhfvCstxeKrRaQp2e8SEHX61Fy",
    },
  };
  if (hasGj) snap.gate_j_mandate = gj;
  cache = { at: now, agent: snap, mandate: null };
  return snap;
}

export async function getLiveMandateSnapshot() {
  const agent = await getLiveAgentSnapshot();
  const limitsRaw = agent.views.limits || agent.gate_j_mandate?.limits || {};
  const limits = isViewError(limitsRaw) ? {} : limitsRaw;
  const validUntilNs = Number(limits.valid_until || 0);
  const nowMs = Date.now();
  const expiryMs = validUntilNs > 0 ? Math.floor(validUntilNs / 1e6) : null;
  const epoch = unwrapView(agent.views.mandate_epoch, null);
  const stateVersion = unwrapView(agent.views.state_version, null);
  const reserved = unwrapView(agent.views.reserved_pending_exposure, "0");
  return {
    ok: true,
    network: "mainnet",
    fetched_at: agent.fetched_at,
    fresh: agent.fresh,
    owner: unwrapView(agent.views.owner, MAINNET_IDENTITIES.owner),
    agent: unwrapView(agent.views.agent, MAINNET_IDENTITIES.agent),
    policy: MAINNET_IDENTITIES.policy,
    portfolio_id: unwrapView(
      agent.views.portfolio_id,
      MAINNET_IDENTITIES.portfolio_id
    ),
    mandate_epoch: typeof epoch === "number" ? epoch : Number(epoch) || null,
    paused: unwrapView(agent.views.paused, null),
    revoked: Boolean(agent.views.revocation?.revoked),
    autonomous_trading: Boolean(unwrapView(agent.views.autonomous_trading, false)),
    enforce_autonomous_on_agent: Boolean(
      unwrapView(agent.views.enforce_autonomous_on_agent, false)
    ),
    state_version:
      typeof stateVersion === "number" || typeof stateVersion === "string"
        ? stateVersion
        : null,
    limits: {
      max_trade_value: limits.max_trade_value ?? null,
      daily_turnover_limit: limits.daily_turnover_limit ?? null,
      max_pending_exposure: limits.max_pending_exposure ?? null,
      max_slippage_bps: limits.max_slippage_bps ?? null,
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
    },
    usage: {
      reserved_pending_exposure:
        typeof reserved === "object" ? "0" : String(reserved ?? "0"),
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
    const url = await pickMainnetRpc();
    onchain = await viewFn(url, "get_decision_cycle", { cycle_id });
  } catch (e) {
    onchain = { error: String(e.message || e) };
  }
  const chainHash =
    onchain && !onchain.error ? onchain.evidence_hash : null;
  const match =
    chainHash &&
    detail.record.evidence_hash &&
    chainHash === detail.record.evidence_hash;
  return {
    ok: true,
    cycle_id,
    offchain_evidence_hash: detail.record.evidence_hash,
    recomputed_ok: detail.integrity.ok,
    onchain_lookup: onchain,
    hash_match: Boolean(match),
    status: match
      ? AUDIT_STATUS.ONCHAIN_VERIFIED
      : detail.meta.status || AUDIT_STATUS.OFFCHAIN_ONLY,
    near_tx: detail.meta.near_tx,
    explorer: detail.meta.explorer,
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
      if (j.error) return { amount: null, status: "unavailable", note: String(j.error) };
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
