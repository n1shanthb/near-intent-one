/**
 * Checkpoint J3 — mainnet agent backend safety + observation tests.
 * No funded txs. No broadcast.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KeyPair } from "near-api-js";
import {
  mainnetExecutionGates,
  assertMainnetBroadcastAllowed,
  guardedMainnetSubmit,
} from "./safetyGates.mjs";
import {
  loadAgentOpsCredentials,
  resolveOpsKeyPath,
  CredentialError,
} from "./agentCredentials.mjs";
import { MAINNET_IDENTITIES } from "./identities.mjs";
import { validateMainnetAgentStartup, constructLocalAgentSign } from "./agentRuntime.mjs";
import { authorizeService } from "../services/apiAuth.mjs";
import { broadcastWithJournal } from "../execution/durableBroadcast.mjs";
import { MAINNET_1CLICK } from "../execution/chainProfiles.mjs";

const FIX = join(tmpdir(), `nio-j3-${process.pid}`);

function writeCred({ account_id, public_key, private_key }) {
  mkdirSync(FIX, { recursive: true });
  const path = join(FIX, "ops.json");
  writeFileSync(
    path,
    JSON.stringify({ account_id, public_key, private_key }, null, 2)
  );
  return path;
}

describe("J3 safety gates", () => {
  it("reports funded_trading / broadcast / autonomous all false", () => {
    const g = mainnetExecutionGates({
      NIO_NETWORK: "mainnet",
      NIO_MAINNET_MODE: "1",
      NIO_MAINNET_ALLOW_SIGN: "1",
      NIO_MAINNET_ALLOW_BROADCAST: "1",
      NIO_FUNDED_TRADING: "1",
      NIO_AUTONOMOUS_EXECUTION: "1",
    });
    assert.equal(g.funded_trading, false);
    assert.equal(g.mainnet_broadcast_enabled, false);
    assert.equal(g.autonomous_execution_enabled, false);
    assert.equal(g.unlock_attempted_ignored, true);
  });

  it("blocks broadcast while disabled", async () => {
    const gate = assertMainnetBroadcastAllowed({ NIO_NETWORK: "mainnet" });
    assert.equal(gate.ok, false);
    assert.equal(gate.submitted, false);
    let called = false;
    const out = await guardedMainnetSubmit(async () => {
      called = true;
      return { ok: true };
    });
    assert.equal(called, false);
    assert.equal(out.ok, false);
  });

  it("blocks durableBroadcast on mainnet profile even without dryRun", async () => {
    const journal = {
      assertWritable() {},
      tryClaim() {
        return { ok: true };
      },
      get() {
        return {
          state: "SIGNED",
          meta_json: "{}",
          broadcast_hash: null,
        };
      },
      loadSignedRaw() {
        return "0xdead";
      },
      markSigned() {},
      beginBroadcast() {
        throw new Error("must_not_begin_broadcast");
      },
      releaseClaim() {},
    };
    const eth = async () => {
      throw new Error("must_not_rpc");
    };
    const r = await broadcastWithJournal({
      journal,
      journalId: "t1",
      signedRawHex: "0xdead",
      profile: MAINNET_1CLICK,
      eth,
      opts: { dryRun: false, depositBound: { ok: true } },
    });
    // May fail earlier on funded gate OR hard broadcast gate — never send
    assert.equal(r.ok, false);
    assert.ok(
      r.reason === "mainnet_broadcast_disabled" ||
        r.reason === "mainnet_broadcast_disabled" ||
        String(r.reason || "").includes("mainnet") ||
        String(r.reason || "").includes("funded") ||
        String(r.reason || "").includes("journal") ||
        String(r.reason || "").includes("gated")
    );
  });
});

describe("J3 credentials", () => {
  it("fails on missing secure credential", () => {
    assert.throws(
      () => resolveOpsKeyPath({}),
      (e) => e instanceof CredentialError && e.code === "missing_secure_credential"
    );
  });

  it("fails on wrong public key", () => {
    const kp = KeyPair.fromRandom("ed25519");
    const path = writeCred({
      account_id: MAINNET_IDENTITIES.agent,
      public_key: kp.getPublicKey().toString(),
      private_key: kp.toString(),
    });
    assert.throws(
      () =>
        loadAgentOpsCredentials({
          path,
          expectedPublicKey: MAINNET_IDENTITIES.ops_public_key,
        }),
      (e) => e.code === "wrong_public_key"
    );
  });

  it("fails on wrong account", () => {
    const kp = KeyPair.fromRandom("ed25519");
    // Use expected pub derived from this key but wrong account_id
    const path = writeCred({
      account_id: "nishanthb.near",
      public_key: MAINNET_IDENTITIES.ops_public_key,
      private_key: kp.toString(),
    });
    assert.throws(
      () =>
        loadAgentOpsCredentials({
          path,
          accountId: MAINNET_IDENTITIES.agent,
          expectedPublicKey: kp.getPublicKey().toString(),
        }),
      (e) => e.code === "wrong_account"
    );
  });

  it("matches public/private for a generated key when expectedPub matches", () => {
    const kp = KeyPair.fromRandom("ed25519");
    const pub = kp.getPublicKey().toString();
    const path = writeCred({
      account_id: MAINNET_IDENTITIES.agent,
      public_key: pub,
      private_key: kp.toString(),
    });
    const cred = loadAgentOpsCredentials({
      path,
      expectedPublicKey: pub,
    });
    assert.equal(cred.public_key, pub);
    const local = constructLocalAgentSign(cred);
    // constructLocalAgentSign is async in runtime — wait
    return local.then((r) => {
      assert.equal(r.ok, true);
      assert.equal(r.broadcast, false);
      assert.ok(r.construction_digest);
      assert.equal(r.signature_verified, true);
    });
  });
});

describe("J3 unauthorized execution", () => {
  it("rejects mutating requests without API key", () => {
    const req = { headers: {}, socket: { remoteAddress: "8.8.8.8" } };
    const r = authorizeService(req, {
      mutating: true,
      apiKey: "secret",
      env: { GATE_I_ALLOW_OPEN_DEV: "0" },
    });
    assert.equal(r.ok, false);
  });
});

describe("J3 startup validation negatives", () => {
  it("fails closed on wrong network", async () => {
    const r = await validateMainnetAgentStartup({
      env: { NIO_NETWORK: "testnet", NIO_AGENT_OPS_KEY_PATH: join(FIX, "nope.json") },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "wrong_network");
  });

  it("fails closed on missing credential file", async () => {
    const r = await validateMainnetAgentStartup({
      env: {
        NIO_NETWORK: "mainnet",
        NIO_AGENT_OPS_KEY_PATH: join(FIX, "does-not-exist.json"),
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "missing_secure_credential");
  });
});

describe("J3 live mainnet observation (optional)", () => {
  it("validates real ops key + paused policy when NIO_AGENT_OPS_KEY_PATH set", async () => {
    const path = process.env.NIO_AGENT_OPS_KEY_PATH;
    if (!path) {
      console.log("skip live startup — NIO_AGENT_OPS_KEY_PATH unset");
      return;
    }
    const r = await validateMainnetAgentStartup({
      env: { ...process.env, NIO_NETWORK: "mainnet", NIO_AGENT_OPS_KEY_PATH: path },
    });
    assert.equal(r.ok, true, JSON.stringify(r.failures || r.reason));
    assert.equal(r.policy.paused, true);
    assert.equal(r.policy.autonomous_trading, false);
    assert.equal(r.gates.mainnet_broadcast_enabled, false);
    assert.equal(Number(r.policy.mandate_epoch), 2);
  });
});
