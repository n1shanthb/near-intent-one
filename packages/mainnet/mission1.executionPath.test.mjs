import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  M1_ETH_NEAR_USDC,
  NEAR_NATIVE_USDC_ASSET,
} from "./canaryRouteProfiles.mjs";
import {
  CANARY_CHAIN_ID,
  CANARY_ASSET_IN,
  CANARY_TOKEN,
} from "./canaryOneShot.mjs";
import {
  assertMission1Bindings,
  buildMission1ApprovalPreview,
  createMission1CanaryApproval,
  validateMission1CanaryApproval,
  buildMission1TransactionPlan,
  verifyMission1Settlement,
  auditMission1ProductionPath,
  MISSION1_APPROVAL_KIND,
  MISSION1_CHAIN_ID,
} from "./mission1ExecutionPath.mjs";
import { resolveCanarySettlementPlan } from "./canarySettlement.mjs";

const env = {
  NIO_CANARY_HMAC_SECRET: "mission1-test-hmac-secret-32bytes!!",
  NIO_JOURNAL_SECRET: "mission1-test-journal-secret-32b!!",
};

describe("Mission1 execution path", () => {
  const dirs = [];
  after(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("preview binds Eth→NEAR and rejects J8B constants", () => {
    const preview = buildMission1ApprovalPreview({ maxSlippageBps: 50 });
    assert.equal(preview.persisted, false);
    assert.equal(preview.payload.kind, MISSION1_APPROVAL_KIND);
    assert.equal(preview.payload.chain_id, 1);
    assert.equal(preview.payload.asset_out, NEAR_NATIVE_USDC_ASSET);
    assert.equal(preview.payload.destination_kind, "nep141");
    assert.throws(() =>
      assertMission1Bindings({
        chain_id: CANARY_CHAIN_ID,
        token: CANARY_TOKEN,
        asset_in: CANARY_ASSET_IN,
        asset_out: "x",
        amount: "1000000",
      })
    );
  });

  it("create+validate Mission1 approval in isolated store (no J8B store)", () => {
    const storeDir = mkdtempSync(join(tmpdir(), "m1-canary-"));
    dirs.push(storeDir);
    const created = createMission1CanaryApproval({
      operationId: "m1-test-op-1",
      env,
      storeDir,
      ttlMs: 60_000,
    });
    assert.equal(created.ok, true);
    assert.equal(created.payload.chain_id, MISSION1_CHAIN_ID);
    const v = validateMission1CanaryApproval("m1-test-op-1", { env, storeDir });
    assert.equal(v.ok, true);
    assert.equal(v.mode, "one_shot_mission1");
  });

  it("transaction plan lists Ledger unpause → propose → sign → Eth broadcast → settle → reconcile", () => {
    const plan = buildMission1TransactionPlan({
      quote: { deposit_address: "0xabc", min_amount_out: "990000" },
      gasEconomics: { fee_eth: 0.00001, fee_usd_approx: 0.03 },
      nonce: 0,
    });
    assert.equal(plan.mutations_invoked, false);
    const actions = plan.steps.map((s) => s.action);
    assert.ok(actions.includes("unpause()"));
    assert.ok(actions.includes("propose_quoted_evm_transfer"));
    assert.ok(actions.includes("request_signature"));
    assert.ok(actions.includes("eth_sendRawTransaction"));
    assert.ok(actions.includes("settlement_verify"));
    assert.ok(actions.some((a) => String(a).startsWith("reconcile_pending")));
    assert.ok(actions.includes("pause()"));
  });

  it("settlement plan selects Eth source + NEAR NEP-141 destination", () => {
    const plan = resolveCanarySettlementPlan(M1_ETH_NEAR_USDC);
    assert.equal(plan.source.chain_id, 1);
    assert.equal(plan.destination.kind, "near_nep141_ft_delta");
    assert.equal(plan.destination.verify, "verifyNearNep141Delta");
  });

  it("verifyMission1Settlement requires Near delta after 1Click SUCCESS", async () => {
    const r = await verifyMission1Settlement({
      txHash: "0xdead",
      depositAddress: "0xescrow",
      minAmountOut: "990000",
      nearUsdcBefore: "0",
      nearRpcUrl: "https://rpc.mainnet.near.org",
      deps: {
        sourceVerify: {
          ok: true,
          status: "CONFIRMED",
          transfer: { value: "1000000" },
        },
        oneClick: { ok: true, terminal: true, normalized: "SUCCESS" },
        nearVerify: {
          ok: true,
          delta: "990000",
          after_raw: "990000",
          kind: "nep141",
        },
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.destination.kind, "nep141");
  });

  it("production path audit is NO-GO until runner asserted", () => {
    const audit = auditMission1ProductionPath({ env });
    assert.equal(audit.ok, false);
    assert.ok(audit.production_ready_components.includes("durable_tx_journal_sqlite_available"));
    assert.ok(
      audit.production_ready_components.includes("mission1_approval_kind_separate_store")
    );
    assert.equal(audit.settlement.destination, "near_nep141_ft_delta");
    assert.ok(audit.hard_stop);
  });

  it("production path audit READY with runner assert", async () => {
    const { auditMission1ProductionPathWithRunner } = await import(
      "./mission1ExecutionPath.mjs"
    );
    const audit = await auditMission1ProductionPathWithRunner({ env });
    assert.equal(audit.ok, true, JSON.stringify(audit.engineering_gaps));
  });
});
