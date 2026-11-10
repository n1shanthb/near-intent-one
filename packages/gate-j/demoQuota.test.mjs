/**
 * Persistent demo quota tests — no network / no LLM.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDemoQuota } from "./demoQuota.mjs";

describe("demoQuota persistent limits", () => {
  let dir;
  let q;
  const prev = {};

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "nio-demo-quota-"));
    for (const k of [
      "GATE_J_DEMO_ENABLED",
      "GATE_J_DEMO_KILL_SWITCH",
      "GATE_J_DEMO_CLIENT_DAILY_LIMIT",
      "GATE_J_DEMO_GLOBAL_DAILY_LIMIT",
      "GATE_J_DEMO_MAX_SPEND_USD",
      "GATE_J_DEMO_MIN_INTERVAL_MS",
    ]) {
      prev[k] = process.env[k];
    }
    process.env.GATE_J_DEMO_ENABLED = "1";
    process.env.GATE_J_DEMO_KILL_SWITCH = "0";
    process.env.GATE_J_DEMO_CLIENT_DAILY_LIMIT = "2";
    process.env.GATE_J_DEMO_GLOBAL_DAILY_LIMIT = "3";
    process.env.GATE_J_DEMO_MAX_SPEND_USD = "0.05";
    process.env.GATE_J_DEMO_MIN_INTERVAL_MS = "0";
    q = createDemoQuota({ dataDir: dir });
  });

  after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("fail-closed kill switch", () => {
    q._resetForTests();
    process.env.GATE_J_DEMO_KILL_SWITCH = "1";
    const r = q.beginRequest({ clientKey: "1.1.1.1" });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "DEMO_KILL_SWITCH");
    process.env.GATE_J_DEMO_KILL_SWITCH = "0";
  });

  it("single-flight blocks concurrent begin", () => {
    q._resetForTests();
    const a = q.beginRequest({ clientKey: "10.0.0.1" });
    assert.equal(a.ok, true);
    const b = q.beginRequest({ clientKey: "10.0.0.2" });
    assert.equal(b.ok, false);
    assert.equal(b.reason, "DEMO_BUSY");
    const rel = q.releaseFlight({ clientKey: "10.0.0.1", counted: true });
    assert.equal(rel.ok, true);
  });

  it("persists client + global counters across recreate", () => {
    q._resetForTests();
    let g = q.beginRequest({ clientKey: "9.9.9.9" });
    assert.equal(g.ok, true);
    q.releaseFlight({ clientKey: "9.9.9.9", counted: true, spendUsdDelta: 0.01 });
    g = q.beginRequest({ clientKey: "9.9.9.9" });
    assert.equal(g.ok, true);
    q.releaseFlight({ clientKey: "9.9.9.9", counted: true, spendUsdDelta: 0.01 });

    const q2 = createDemoQuota({ dataDir: dir });
    const blocked = q2.beginRequest({ clientKey: "9.9.9.9" });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, "DEMO_CLIENT_DAILY_LIMIT");

    // other client still ok until global
    const other = q2.beginRequest({ clientKey: "8.8.8.8" });
    assert.equal(other.ok, true);
    q2.releaseFlight({ clientKey: "8.8.8.8", counted: true, spendUsdDelta: 0.01 });

    const globalBlock = q2.beginRequest({ clientKey: "7.7.7.7" });
    assert.equal(globalBlock.ok, false);
    assert.equal(globalBlock.reason, "DEMO_GLOBAL_DAILY_LIMIT");
  });

  it("spend cap fail-closed from persisted state", () => {
    q._resetForTests({ spend_usd: 0.05, global_calls: 0, clients: {} });
    const r = q.beginRequest({ clientKey: "5.5.5.5" });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "DEMO_SPEND_CAP");
  });

  it("status reports remaining", () => {
    q._resetForTests({ spend_usd: 0.01, global_calls: 1 });
    const st = q.getStatus();
    assert.equal(st.ok, true);
    assert.equal(st.usage.global_calls, 1);
    assert.ok(st.remaining.global_calls >= 1);
  });
});
