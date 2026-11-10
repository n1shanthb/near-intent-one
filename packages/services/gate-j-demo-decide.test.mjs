/**
 * Demo-decide hard locks — no live LLM / no chain.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateJHandlers } from "./gate-j-routes.mjs";

function mockStore() {
  return {
    getPortfolio: (id) =>
      id === "i-a-a4e7"
        ? {
            portfolio_id: "i-a-a4e7",
            owner_account: "nio-i-a4e7-a-owner.testnet",
            policy_contract: "policy.nio-i-a4e7-a-owner.testnet",
            intents_signer_id: "0xabc",
          }
        : null,
    recordDecision: () => {},
  };
}

describe("gate-j demoDecide hard locks", () => {
  let dir;
  let handlers;
  const prev = {};

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "nio-demo-decide-"));
    for (const k of [
      "GATE_J_DEMO_ENABLED",
      "GATE_J_DEMO_KILL_SWITCH",
      "GATE_J_DEMO_CLIENT_DAILY_LIMIT",
      "GATE_J_DEMO_GLOBAL_DAILY_LIMIT",
      "GATE_J_DEMO_MAX_SPEND_USD",
      "GATE_J_DEMO_MIN_INTERVAL_MS",
      "OPENROUTER_API_KEY",
    ]) {
      prev[k] = process.env[k];
    }
    process.env.GATE_J_DEMO_ENABLED = "1";
    process.env.GATE_J_DEMO_KILL_SWITCH = "0";
    process.env.GATE_J_DEMO_CLIENT_DAILY_LIMIT = "5";
    process.env.GATE_J_DEMO_GLOBAL_DAILY_LIMIT = "10";
    process.env.GATE_J_DEMO_MAX_SPEND_USD = "1";
    process.env.GATE_J_DEMO_MIN_INTERVAL_MS = "0";
    // Ensure we don't accidentally call OpenRouter in these unit tests
    delete process.env.OPENROUTER_API_KEY;

    handlers = createGateJHandlers({
      store: mockStore(),
      evidenceDir: join(dir, "ev"),
      dataDir: dir,
      viewFunction: null,
      fetchUsdcBalance: null,
      fetchEthBalance: null,
      fetchIntentsUsdc: null,
    });
  });

  after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects malicious allow_execute / acceptance_override fields", async () => {
    for (const field of [
      "allow_execute",
      "confirm_funded_trade",
      "acceptance_override",
      "gate_k_execute",
      "may_sign",
      "withdraw",
      "set_policy",
    ]) {
      const out = await handlers.demoDecide(
        { [field]: true, dry_run: false, use_llm: false, portfolio_id: "evil" },
        { ip: "203.0.113.10" }
      );
      assert.equal(out.ok, false, field);
      assert.equal(out.reason, "DEMO_FORBIDDEN_FIELD", field);
      assert.equal(out.may_sign, undefined);
      assert.equal(out.field, field);
    }
  });

  it("never signs even with malicious portfolio / dry_run=false body", async () => {
    const out = await handlers.demoDecide(
      {
        portfolio_id: "evil-portfolio",
        use_llm: false,
        dry_run: false,
        allow_execute: false,
        mandate: { per_trade_limit_usdc_raw: "999999999999" },
      },
      { ip: "203.0.113.11" }
    );
    assert.equal(out.ok, false);
    assert.equal(out.demo, true);
    assert.equal(out.may_sign, false);
    assert.equal(out.no_signing, true);
    assert.equal(out.DRY_RUN, true);
    assert.equal(out.forced?.may_sign, false);
    assert.equal(out.forced?.portfolio_id, "i-a-a4e7");
    // Fail-closed before or during hydrate/LLM — never a signing auth path.
    assert.ok(
      [
        "OPENROUTER_NOT_CONFIGURED",
        "OPENROUTER_REQUIRED",
        "on_chain_view_unavailable",
        "BALANCE_UNVERIFIED",
        "portfolio_not_found",
        "mandate_hydration_failed",
      ].includes(out.reason),
      out.reason
    );
  });

  it("demo-status is available", () => {
    const st = handlers.demoStatus();
    assert.equal(st.ok, true);
    assert.equal(st.portfolio_id, "i-a-a4e7");
    assert.ok(st.limits.client_daily >= 1);
  });

  it("kill switch blocks before any pipeline", async () => {
    process.env.GATE_J_DEMO_KILL_SWITCH = "1";
    const out = await handlers.demoDecide({}, { ip: "203.0.113.12" });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "DEMO_KILL_SWITCH");
    assert.equal(out.may_sign, false);
    process.env.GATE_J_DEMO_KILL_SWITCH = "0";
  });
});
