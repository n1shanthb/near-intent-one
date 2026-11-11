/**
 * Mainnet MVP unit tests — no funded txs, no broadcast.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAINNET,
  TESTNET,
  assertNetworkIsolation,
  mainnetAuthGates,
  assertMainnetCanaryAuthorized,
  MPC_SIGNER,
} from "../networks/profiles.mjs";
import {
  portfolioDerivationPath,
  mainnetSignRequirements,
} from "./mpc.mjs";
import {
  normalizeIntentStatus,
} from "./intents.mjs";
import {
  evaluateCanaryReadiness,
  mainnetTradeSafetyCheck,
} from "./canary.mjs";
import { buildInitArgs, sha256File, DEFAULT_WASM } from "./deploy.mjs";
import { existsSync } from "node:fs";

describe("network isolation", () => {
  it("keeps MPC signers and intents backends distinct", () => {
    assert.equal(TESTNET.mpc.signer, MPC_SIGNER.testnet);
    assert.equal(MAINNET.mpc.signer, MPC_SIGNER.mainnet);
    assert.equal(TESTNET.intents.kind, "tidepool_sandbox");
    assert.equal(MAINNET.intents.kind, "near_intents_1click");
    assert.notEqual(TESTNET.evm.chainId, MAINNET.evm.chainId);
    assert.throws(() => assertNetworkIsolation(MAINNET, { allowMainnet: false }));
    assert.doesNotThrow(() =>
      assertNetworkIsolation(MAINNET, { allowMainnet: true })
    );
  });

  it("defaults all mainnet funded gates OFF", () => {
    const g = mainnetAuthGates({});
    assert.equal(g.mainnet_mode, false);
    assert.equal(g.allow_sign, false);
    assert.equal(g.allow_broadcast, false);
    assert.equal(g.canary_approved, false);
  });
});

describe("mainnet mpc helpers", () => {
  it("builds stable portfolio derivation paths", () => {
    assert.equal(
      portfolioDerivationPath("hack26-canary"),
      "trading/v1/portfolio/hack26-canary"
    );
    assert.throws(() => portfolioDerivationPath("bad/id"));
    const req = mainnetSignRequirements();
    assert.equal(req.signer, "v1.signer");
    assert.equal(req.funded_sign_default.includes("OFF"), true);
  });
});

describe("canary + trade safety", () => {
  it("blocks canary without approval and without testnet proof", () => {
    const r = evaluateCanaryReadiness({
      testnetLifecycleOk: false,
      policyDeployed: false,
      ledgerOwned: false,
      env: {},
    });
    assert.equal(r.ready, false);
    assert.ok(r.blockers.length >= 3);
  });

  it("rejects canary approval for testnet-style owner", () => {
    const out = assertMainnetCanaryAuthorized(
      {
        owner_account: "alice.testnet",
        chain: "arbitrum",
        policy_contract: "nio-policy.near",
        source_token: "USDC",
        destination_token: "wNEAR",
        max_at_risk: "1",
        max_fees: "0.1",
        destination_address: "0x1",
        refund_address: "0x1",
        purpose: "test",
      },
      {
        NIO_NETWORK: "mainnet",
        NIO_MAINNET_MODE: "1",
        NIO_MAINNET_CANARY_APPROVED: "1",
        NIO_MAINNET_ALLOW_SIGN: "1",
      }
    );
    assert.equal(out.ok, false);
    assert.equal(out.reason, "owner_must_be_mainnet_account");
  });

  it("never allows acceptance override; AI reject stays BLOCKED", () => {
    const blocked = mainnetTradeSafetyCheck({
      sessionAccount: "alice.near",
      portfolioOwner: "alice.near",
      mandate: { revoked: false, paused: false },
      fitter: { decision: "REJECT" },
      critic: { decision: "APPROVE" },
      quote: {
        fresh: true,
        recipient: "0xabc",
        refundTo: "0xabc",
      },
      destination: "0xabc",
      refund: "0xabc",
    });
    assert.equal(blocked.status, "BLOCKED");
    assert.ok(blocked.reasons.includes("ai_rejection_is_final_no_override"));
    assert.equal(blocked.acceptance_override, "FORBIDDEN");
  });

  it("passes safety only when fitter+critic approve and addresses match", () => {
    const ok = mainnetTradeSafetyCheck({
      sessionAccount: "alice.near",
      portfolioOwner: "alice.near",
      mandate: { revoked: false, paused: false },
      fitter: { decision: "APPROVE" },
      critic: { decision: "APPROVE" },
      quote: {
        fresh: true,
        recipient: "0xabc",
        refundTo: "0xdef",
        slippage_bps: 10,
      },
      maxSlippageBps: 50,
      destination: "0xabc",
      refund: "0xdef",
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.acceptance_override, "FORBIDDEN");
  });
});

describe("intents status model", () => {
  it("normalizes SUCCESS/FAILED/REFUNDED/PENDING", () => {
    assert.equal(normalizeIntentStatus("SUCCESS"), "SUCCESS");
    assert.equal(normalizeIntentStatus({ status: "REFUNDED" }), "REFUNDED");
    assert.equal(normalizeIntentStatus("FAILED"), "FAILED");
    assert.equal(normalizeIntentStatus("PENDING"), "PENDING");
  });
});

describe("wasm artifact", () => {
  it("hashes release wasm when present", () => {
    if (!existsSync(DEFAULT_WASM)) {
      console.log("# skip: policy.wasm not built");
      return;
    }
    const h = sha256File(DEFAULT_WASM);
    assert.ok(h.bytes > 10_000);
    assert.equal(h.sha256.length, 64);
  });

  it("rejects demo init args", () => {
    assert.throws(() =>
      buildInitArgs({
        owner: "nio-c-owner.near",
        agent: "agent.near",
        portfolio_id: "x",
      })
    );
  });
});
