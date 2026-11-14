/**
 * Canonical AI decision audit record + optional NEAR mainnet anchoring.
 * Never fabricates ONCHAIN_VERIFIED without a verified receipt.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export const AUDIT_STATUS = Object.freeze({
  OFFCHAIN_ONLY: "OFFCHAIN_ONLY",
  UNANCHORED: "UNANCHORED",
  VERIFICATION_PENDING: "VERIFICATION_PENDING",
  ONCHAIN_VERIFIED: "ONCHAIN_VERIFIED",
  ANCHOR_FAILED: "ANCHOR_FAILED",
});

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

export function hashEvidence(record) {
  return createHash("sha256").update(stableStringify(record), "utf8").digest("hex");
}

export function makeCycleId({ portfolio_id, decision_hash, ts = Date.now() }) {
  const short = String(decision_hash || "x").slice(0, 16);
  const salt = randomBytes(4).toString("hex");
  return `cyc-${String(portfolio_id || "p").slice(0, 24)}-${short}-${ts}-${salt}`
    .replace(/[^A-Za-z0-9_\-:]/g, "-")
    .slice(0, 96);
}

/**
 * Build redacted canonical evidence (no prompts, keys, or raw market dumps).
 */
export function buildCanonicalDecisionRecord({
  decision,
  mandate,
  onChain = {},
  policy = "policy.nishanthb.near",
  cycle_id = null,
}) {
  const fitter = decision?.fitter || {};
  const critic = decision?.critic || {};
  const strategy = decision?.strategy || {};
  const research = decision?.research || {};
  const action = decision?.action === "TRADE" ? "TRADE" : "NO_TRADE";
  const fitter_verdict =
    fitter.outcome === "ACCEPTED" || fitter.outcome === "ADAPTED" || fitter.outcome === "REJECTED"
      ? fitter.outcome
      : "REJECTED";
  let critic_verdict = "SKIPPED";
  if (critic?.veto === true || critic?.outcome === "VETOED") critic_verdict = "VETOED";
  else if (critic?.approved === true || critic?.outcome === "APPROVED") critic_verdict = "APPROVED";

  const proposed_amount_raw = String(
    strategy.amount_raw || strategy.size_raw || fitter.proposed_amount_raw || "0"
  );
  const fitted_amount_raw =
    fitter.fitted_amount_raw != null
      ? String(fitter.fitted_amount_raw)
      : fitter.amount_raw != null
        ? String(fitter.amount_raw)
        : null;

  const cid =
    cycle_id ||
    makeCycleId({
      portfolio_id: mandate?.portfolio_id || onChain?.portfolio_id,
      decision_hash: decision?.decision_hash,
    });

  const body = {
    kind: "nio_agent_audit_v1",
    cycle_id: cid,
    portfolio_id: mandate?.portfolio_id || "unknown",
    policy,
    agent: mandate?.agent_id || mandate?.executor_id || "agent.nishanthb.near",
    mandate_epoch: Number(onChain?.mandate_epoch ?? mandate?.epoch ?? mandate?.mandate_epoch ?? 0),
    proposal_id: String(strategy.proposal_id || decision?.decision_hash || cid).slice(0, 96),
    chain_id: String(strategy.chain_id || strategy.chain || "").slice(0, 64),
    asset_in: String(strategy.asset_in || strategy.origin_asset || "").slice(0, 128),
    asset_out: String(strategy.asset_out || strategy.destination_asset || "").slice(0, 128),
    proposed_amount_raw,
    fitted_amount_raw,
    fitter_verdict,
    critic_verdict,
    final_action: action,
    reason_code: String(decision?.reason || "UNKNOWN").slice(0, 64),
    decision_hash: decision?.decision_hash || null,
    mandate_hash: decision?.mandate_hash || null,
    models: decision?.evidence?.models || null,
    fitter_reason_codes: (fitter.reason_codes || []).slice(0, 8),
    timestamp_ms: decision?.timestamp_ms || Date.now(),
    labels: {
      network: "MAINNET",
      mode: "AUTONOMOUS",
      settlement: "NOT_SETTLED",
    },
  };
  const evidence_hash = hashEvidence(body);
  return { ...body, evidence_hash };
}

export function defaultAuditStoreDir() {
  return (
    process.env.NIO_DECISION_AUDIT_DIR ||
    join(homedir(), ".nio-secure", "mainnet-decision-audit")
  );
}

export async function persistCanonicalRecord(record, storeDir = defaultAuditStoreDir()) {
  await mkdir(storeDir, { recursive: true });
  const path = join(storeDir, `${record.cycle_id}.json`);
  // Persist before any chain submit (crash-safe).
  const marker = join(storeDir, `${record.cycle_id}.pending.json`);
  await writeFile(marker, JSON.stringify({ ...record, status: AUDIT_STATUS.UNANCHORED }, null, 2));
  await writeFile(path, JSON.stringify(record, null, 2));
  return path;
}

export async function loadCanonicalRecord(cycle_id, storeDir = defaultAuditStoreDir()) {
  const path = join(storeDir, `${cycle_id}.json`);
  try {
    await access(path);
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export async function listCanonicalRecords(storeDir = defaultAuditStoreDir(), limit = 50) {
  const { readdir } = await import("node:fs/promises");
  try {
    const files = (await readdir(storeDir))
      .filter((f) => f.endsWith(".json") && !f.endsWith(".pending.json") && !f.endsWith(".meta.json"))
      .sort()
      .reverse()
      .slice(0, limit);
    const out = [];
    for (const f of files) {
      try {
        out.push(JSON.parse(await readFile(join(storeDir, f), "utf8")));
      } catch {
        /* skip */
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function toContractArgs(record) {
  return {
    cycle_id: record.cycle_id,
    portfolio_id: record.portfolio_id,
    mandate_epoch: Number(record.mandate_epoch),
    proposal_id: record.proposal_id || record.cycle_id,
    chain_id: record.chain_id || "",
    asset_in: record.asset_in || "",
    asset_out: record.asset_out || "",
    proposed_amount_raw: String(record.proposed_amount_raw || "0"),
    fitted_amount_raw:
      record.fitted_amount_raw != null ? String(record.fitted_amount_raw) : null,
    fitter_verdict: record.fitter_verdict,
    critic_verdict: record.critic_verdict,
    final_action: record.final_action,
    reason_code: record.reason_code,
    evidence_hash: record.evidence_hash,
  };
}

/**
 * Publish via optional adapter. Adapter must return { ok, tx_hash, logs?, error? }.
 */
export async function anchorDecisionOnChain({
  record,
  publishFn = null,
  storeDir = defaultAuditStoreDir(),
  enabled = process.env.NIO_DECISION_AUDIT_ON_CHAIN === "1",
}) {
  const metaPath = join(storeDir, `${record.cycle_id}.meta.json`);
  let meta = {
    cycle_id: record.cycle_id,
    evidence_hash: record.evidence_hash,
    status: AUDIT_STATUS.OFFCHAIN_ONLY,
    near_tx: null,
    explorer: null,
    verified_at: null,
    error: null,
  };

  if (!enabled || !publishFn) {
    meta.status = enabled ? AUDIT_STATUS.UNANCHORED : AUDIT_STATUS.OFFCHAIN_ONLY;
    meta.error = enabled ? "publish_adapter_missing" : "audit_on_chain_disabled";
    await writeFile(metaPath, JSON.stringify(meta, null, 2));
    return meta;
  }

  // Resume if already verified
  try {
    const prev = JSON.parse(await readFile(metaPath, "utf8"));
    if (prev.status === AUDIT_STATUS.ONCHAIN_VERIFIED && prev.near_tx) {
      return prev;
    }
  } catch {
    /* fresh */
  }

  meta.status = AUDIT_STATUS.VERIFICATION_PENDING;
  await writeFile(metaPath, JSON.stringify(meta, null, 2));

  let result;
  try {
    result = await publishFn(toContractArgs(record));
  } catch (e) {
    meta.status = AUDIT_STATUS.ANCHOR_FAILED;
    meta.error = String(e.message || e).slice(0, 300);
    await writeFile(metaPath, JSON.stringify(meta, null, 2));
    return meta;
  }

  if (!result?.ok || !result.tx_hash) {
    meta.status = AUDIT_STATUS.ANCHOR_FAILED;
    meta.error = result?.error || "publish_failed";
    await writeFile(metaPath, JSON.stringify(meta, null, 2));
    return meta;
  }

  const logs = result.logs || [];
  const hasFinal = logs.some(
    (l) =>
      typeof l === "string" &&
      l.includes("nio_agent_audit") &&
      l.includes("decision_finalized") &&
      l.includes(record.evidence_hash)
  );
  const hasFitter = logs.some(
    (l) =>
      typeof l === "string" &&
      l.includes("fitter_evaluated") &&
      l.includes(record.fitter_verdict)
  );

  if (hasFinal && hasFitter) {
    meta.status = AUDIT_STATUS.ONCHAIN_VERIFIED;
    meta.near_tx = result.tx_hash;
    meta.explorer = `https://nearblocks.io/txns/${result.tx_hash}`;
    meta.verified_at = new Date().toISOString();
    meta.error = null;
  } else {
    meta.status = AUDIT_STATUS.VERIFICATION_PENDING;
    meta.near_tx = result.tx_hash;
    meta.explorer = `https://nearblocks.io/txns/${result.tx_hash}`;
    meta.error = "receipt_logs_incomplete_or_unverified";
  }
  await writeFile(metaPath, JSON.stringify(meta, null, 2));
  return meta;
}

/**
 * End-to-end: persist + optional anchor after a keeper decision.
 */
export async function recordAndMaybeAnchorDecision(opts) {
  const record = buildCanonicalDecisionRecord({
    ...opts,
    cycle_id: opts.cycle_id || null,
  });
  const path = await persistCanonicalRecord(record, opts.storeDir);
  const meta = await anchorDecisionOnChain({
    record,
    publishFn: opts.publishFn || null,
    storeDir: opts.storeDir || defaultAuditStoreDir(),
    enabled: opts.enabled ?? process.env.NIO_DECISION_AUDIT_ON_CHAIN === "1",
  });
  return { record, path, meta };
}

export function recomputeAndCompare(record) {
  const { evidence_hash: claimed, ...rest } = record;
  const recomputed = hashEvidence(rest);
  return {
    ok: claimed === recomputed,
    claimed,
    recomputed,
  };
}
