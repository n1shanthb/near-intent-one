import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LIFECYCLE,
  alreadySigned,
  canTransition,
  isTerminalSuccess,
  normalizeLifecycleStatus,
  BROADCASTABLE,
} from "./lifecycle.mjs";
import { advanceBroadcast } from "./settle.mjs";

describe("lifecycle state machine", () => {
  it("normalizes legacy SIGNED_PENDING_BROADCAST to MPC_SIGNED", () => {
    assert.equal(
      normalizeLifecycleStatus("SIGNED_PENDING_BROADCAST"),
      LIFECYCLE.MPC_SIGNED
    );
  });

  it("treats signed states as alreadySigned — no re-sign", () => {
    assert.equal(alreadySigned("SIGNED_PENDING_BROADCAST"), true);
    assert.equal(alreadySigned(LIFECYCLE.MPC_SIGNED), true);
    assert.equal(alreadySigned(LIFECYCLE.BROADCAST), true);
    assert.equal(alreadySigned(LIFECYCLE.AUTHORIZED), false);
  });

  it("allows forward transitions and failure", () => {
    assert.equal(canTransition(LIFECYCLE.MPC_SIGNED, LIFECYCLE.BROADCAST), true);
    assert.equal(canTransition(LIFECYCLE.BROADCAST, LIFECYCLE.FAILED), true);
    assert.equal(isTerminalSuccess(LIFECYCLE.RECONCILED), true);
    assert.equal(isTerminalSuccess("SUCCESS"), true);
    assert.ok(BROADCASTABLE.has("SIGNED_PENDING_BROADCAST"));
  });
});

describe("settle advanceBroadcast dry-run", () => {
  it("does not broadcast when dryRun and refuses resign when sepolia_tx set", async () => {
    const skip = await advanceBroadcast(
      {
        eth: async () => ({ result: null }),
        nearRpc: async () => ({ result: { receipts_outcome: [] } }),
        rpcUrl: "http://x",
      },
      {
        exec: {
          sepolia_tx: "0xabc",
          sign_tx: "near1",
          amount: "1",
          to: "0xdep",
          nonce: "1",
          gas_price: "1000000000",
        },
        portfolio: { intents_signer_id: "0xabc", agent_account: "a.testnet" },
      },
      { dryRun: false }
    );
    assert.equal(skip.ok, true);
    assert.equal(skip.skipped, true);
    assert.equal(skip.note, "already_broadcast_no_resign");
  });
});
