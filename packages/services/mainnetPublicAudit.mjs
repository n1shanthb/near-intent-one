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
const CACHE_MS = 15_000;

export async function getLiveAgentSnapshot() {
  const now = Date.now();
  if (cache.agent && now - cache.at < CACHE_MS) {
    return { ...cache.agent, cache_age_ms: now - cache.at, fresh: false };
  }
  const url = await pickMainnetRpc();
  const acct = await viewAccount(url);
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
      owner: await viewFn(url, "get_owner"),
      agent: await viewFn(url, "get_agent"),
      portfolio_id: await viewFn(url, "get_portfolio_id"),
      paused: await viewFn(url, "get_paused"),
      mandate_epoch: await viewFn(url, "get_mandate_epoch"),
      autonomous_trading: await viewFn(url, "get_autonomous_trading"),
      enforce_autonomous_on_agent: await viewFn(url, "get_enforce_autonomous_on_agent"),
      state_version: await viewFn(url, "get_state_version"),
      revocation: await viewFn(url, "get_revocation_status"),
      reserved_pending_exposure: await viewFn(url, "get_reserved_pending_exposure"),
      intents_signer_id: await viewFn(url, "get_intents_signer_id"),
      derivation_path: await viewFn(url, "get_derivation_path"),
    },
    provenance: {
      deploy_tx: "7rxXmYqbDL7HyBtG2EKo4g1xHbJYptphg9jMLU7Konrf",
      migrate_tx: "3XHBXDPWMhmDymZdh4NrVZfxYwp9DqcbekLVVrxVSYME",
      activate_tx: "6zQs6C56tdPYz5BYY9Ca2T4XusU5oavt1gDw3tdDaW93",
      unpause_tx: "9jaW3jv5z2adx8aV6xXhfvCstxeKrRaQp2e8SEHX61Fy",
    },
  };
  const gj = await viewFn(url, "get_gate_j_mandate");
  if (!gj?.error) {
    snap.gate_j_mandate = gj;
    snap.views.daily_turnover = gj.daily_turnover;
    snap.views.realized_exposure = gj.realized_exposure;
    snap.views.limits = gj.limits;
  } else {
    snap.views.limits = await viewFn(url, "get_limits");
  }
  cache = { at: now, agent: snap, mandate: null };
  return snap;
}

export async function getLiveMandateSnapshot() {
  const agent = await getLiveAgentSnapshot();
  const limits = agent.views.limits || agent.gate_j_mandate?.limits || {};
  const validUntilNs = Number(limits.valid_until || 0);
  const nowMs = Date.now();
  const expiryMs = validUntilNs > 0 ? Math.floor(validUntilNs / 1e6) : null;
  return {
    ok: true,
    network: "mainnet",
    fetched_at: agent.fetched_at,
    fresh: agent.fresh,
    owner: agent.views.owner,
    agent: agent.views.agent,
    policy: MAINNET_IDENTITIES.policy,
    portfolio_id: agent.views.portfolio_id,
    mandate_epoch: agent.views.mandate_epoch,
    paused: agent.views.paused,
    revoked: agent.views.revocation?.revoked ?? false,
    autonomous_trading: agent.views.autonomous_trading,
    enforce_autonomous_on_agent: agent.views.enforce_autonomous_on_agent,
    state_version: agent.views.state_version,
    limits: {
      max_trade_value: limits.max_trade_value,
      daily_turnover_limit: limits.daily_turnover_limit,
      max_pending_exposure: limits.max_pending_exposure,
      max_slippage_bps: limits.max_slippage_bps,
      max_gas_budget: limits.max_gas_budget,
      token_scope: limits.token_scope,
      allowed_chains: limits.allowed_chains || [],
      allowed_assets: limits.allowed_assets || [],
      allowed_venues: limits.allowed_venues || [],
      allowed_destinations: limits.allowed_destinations || [],
      valid_until: limits.valid_until,
    },
    usage: {
      reserved_pending_exposure: agent.views.reserved_pending_exposure,
      daily_turnover: agent.views.daily_turnover,
      realized_exposure: agent.views.realized_exposure,
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
