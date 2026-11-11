import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./store.mjs";
import {
  createWithdrawLifecycle,
  WITHDRAW_STATUS,
} from "./withdrawLifecycle.mjs";

describe("withdraw lifecycle", () => {
  it("prepares Ledger-bound withdraw and attaches owner tx idempotently", () => {
    const dir = mkdtempSync(join(tmpdir(), "nio-wd-"));
    try {
      const store = openStore(dir);
      const wd = createWithdrawLifecycle({ store });
      const portfolio = {
        portfolio_id: "i-u-1",
        owner_account: "alice.testnet",
        policy_contract: "policy.alice.testnet",
        intents_signer_id: "0xabc",
      };
      const prep = wd.prepare({
        portfolio,
        owner_account: "alice.testnet",
        destination: "0xdest",
        amount: "1000000",
        session_id: "sess1",
      });
      assert.equal(prep.ok, true);
      assert.equal(prep.status, WITHDRAW_STATUS.AWAITING_OWNER_SIGNATURE);
      assert.equal(
        prep.near_function_call.method_name,
        "owner_request_withdraw_signature"
      );

      const bad = wd.attachOwnerTx({
        withdraw_id: prep.withdraw.withdraw_id,
        owner_account: "eve.testnet",
        near_tx_hash: "abc123456789012345",
      });
      assert.equal(bad.reason, "owner_mismatch");

      const ok = wd.attachOwnerTx({
        withdraw_id: prep.withdraw.withdraw_id,
        owner_account: "alice.testnet",
        near_tx_hash: "abc123456789012345",
      });
      assert.equal(ok.ok, true);
      assert.equal(ok.status, WITHDRAW_STATUS.OWNER_SUBMITTED);

      const again = wd.attachOwnerTx({
        withdraw_id: prep.withdraw.withdraw_id,
        owner_account: "alice.testnet",
        near_tx_hash: "abc123456789012345",
      });
      assert.equal(again.idempotent, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
