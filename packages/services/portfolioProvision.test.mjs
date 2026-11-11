import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./store.mjs";
import { createPortfolioProvision } from "./portfolioProvision.mjs";

describe("portfolio provision", () => {
  it("rejects demo owners and registers matching on-chain policy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nio-prov-"));
    try {
      const store = openStore(dir);
      const views = {
        get_owner: "alice.testnet",
        get_portfolio_id: "i-u-test01",
        get_intents_signer_id: "0xabc123",
        get_derivation_path: "trading/v1/portfolio/i-u-test01",
        get_agent: "agent.testnet",
        get_reconciler: "recon.testnet",
      };
      const prov = createPortfolioProvision({
        store,
        viewFunction: async (_c, method) => views[method],
      });

      await assert.rejects(
        async () =>
          prov.registerExisting({
            owner_account: "nio-c-demo.testnet",
            policy_contract: "policy.testnet",
          }),
        /demo_owner_forbidden/
      );

      const badOwner = await prov.registerExisting({
        owner_account: "eve.testnet",
        policy_contract: "policy.testnet",
      });
      assert.equal(badOwner.reason, "policy_owner_mismatch");

      const ok = await prov.registerExisting({
        owner_account: "alice.testnet",
        policy_contract: "policy.testnet",
      });
      assert.equal(ok.ok, true);
      assert.equal(ok.status, "ready");
      assert.equal(ok.portfolio.owner_account, "alice.testnet");
      assert.equal(ok.portfolio.isolated, true);

      const req = prov.requestProvision({ owner_account: "bob.testnet" });
      assert.equal(req.ok, true);
      assert.ok(
        req.status === "awaiting_operator" || req.status === "queued_self"
      );
      assert.ok(req.portfolio_id.startsWith("i-u-"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
