import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCanonicalDecisionRecord,
  hashEvidence,
  recomputeAndCompare,
  persistCanonicalRecord,
  recordAndMaybeAnchorDecision,
  AUDIT_STATUS,
} from "./decisionAudit.mjs";

test("canonical hash is stable and excludes secrets", () => {
  const decision = {
    action: "NO_TRADE",
    reason: "NO_OPPORTUNITY",
    decision_hash: "abc123",
    mandate_hash: "def456",
    timestamp_ms: 1,
    fitter: { outcome: "REJECTED", reason_codes: ["NO_OPPORTUNITY"] },
    critic: { outcome: "SKIPPED" },
    strategy: { chain_id: "eip155:1", asset_in: "usdc", amount_raw: "1000000" },
    evidence: { models: { researcher: "x" }, prompt: "SECRET_SHOULD_NOT_APPEAR" },
  };
  const a = buildCanonicalDecisionRecord({
    decision,
    mandate: {
      portfolio_id: "nio-mainnet-v1",
      agent_id: "agent.nishanthb.near",
      epoch: 3,
    },
    onChain: { mandate_epoch: 3 },
    cycle_id: "cyc-test-fixed-001",
  });
  const b = buildCanonicalDecisionRecord({
    decision,
    mandate: {
      portfolio_id: "nio-mainnet-v1",
      agent_id: "agent.nishanthb.near",
      epoch: 3,
    },
    onChain: { mandate_epoch: 3 },
    cycle_id: "cyc-test-fixed-001",
  });
  assert.equal(a.evidence_hash, b.evidence_hash);
  assert.equal(a.final_action, "NO_TRADE");
  assert.equal(a.fitter_verdict, "REJECTED");
  const blob = JSON.stringify(a);
  assert.equal(blob.includes("SECRET_SHOULD_NOT_APPEAR"), false);
  assert.equal(recomputeAndCompare(a).ok, true);
});

test("failed anchor is never ONCHAIN_VERIFIED", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nio-audit-"));
  try {
    const out = await recordAndMaybeAnchorDecision({
      decision: {
        action: "NO_TRADE",
        reason: "NO_OPPORTUNITY",
        decision_hash: "h1",
        fitter: { outcome: "REJECTED" },
        timestamp_ms: Date.now(),
      },
      mandate: { portfolio_id: "p1", agent_id: "agent.x.near", epoch: 3 },
      onChain: { mandate_epoch: 3 },
      storeDir: dir,
      enabled: true,
      publishFn: async () => ({ ok: false, error: "method_not_found" }),
    });
    assert.equal(out.meta.status, AUDIT_STATUS.ANCHOR_FAILED);
    assert.notEqual(out.meta.status, AUDIT_STATUS.ONCHAIN_VERIFIED);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verified only when logs bind evidence hash + fitter", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nio-audit-"));
  try {
    const decision = {
      action: "NO_TRADE",
      reason: "NO_OPPORTUNITY",
      decision_hash: "h2",
      fitter: { outcome: "REJECTED" },
      timestamp_ms: Date.now(),
    };
    const draft = buildCanonicalDecisionRecord({
      decision,
      mandate: { portfolio_id: "p1", agent_id: "a", epoch: 3 },
      onChain: { mandate_epoch: 3 },
      cycle_id: "cyc-verify-fixed-9",
    });
    const out = await recordAndMaybeAnchorDecision({
      decision,
      mandate: { portfolio_id: "p1", agent_id: "a", epoch: 3 },
      onChain: { mandate_epoch: 3 },
      storeDir: dir,
      enabled: true,
      cycle_id: "cyc-verify-fixed-9",
      publishFn: async (args) => ({
        ok: true,
        tx_hash: "FakeTxHash111111111111111111111111111111111",
        logs: [
          `EVENT_JSON:{"standard":"nio_agent_audit","version":"1.0.0","event":"fitter_evaluated","data":{"verdict":"REJECTED","evidence_hash":"${args.evidence_hash}"}}`,
          `EVENT_JSON:{"standard":"nio_agent_audit","version":"1.0.0","event":"decision_finalized","data":{"evidence_hash":"${args.evidence_hash}"}}`,
        ],
      }),
    });
    assert.equal(out.meta.status, AUDIT_STATUS.ONCHAIN_VERIFIED);
    assert.equal(out.record.cycle_id, draft.cycle_id);
    assert.ok(typeof hashEvidence === "function");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
