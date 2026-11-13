/**
 * Mainnet agent runtime — credentials, startup validation, local sign-only,
 * and hard broadcast refusal.
 */
import * as nearAPI from "near-api-js";
import { createHash, randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import {
  MAINNET,
  assertNetworkIsolation,
} from "../networks/profiles.mjs";
import { pickRpc, viewFunction, nearRpc, viewAccount } from "../networks/rpc.mjs";
import { MAINNET_IDENTITIES } from "./identities.mjs";
import { loadAgentOpsCredentials, redactSecrets } from "./agentCredentials.mjs";
import {
  mainnetExecutionGates,
  assertMainnetBroadcastAllowed,
  guardedMainnetSubmit,
} from "./safetyGates.mjs";

const { connect, keyStores } = nearAPI;

function keyPresent(j) {
  if (j.error) return { present: false, reason: "rpc_error" };
  if (j.result?.error) return { present: false, reason: String(j.result.error) };
  if (j.result?.permission != null || j.result?.nonce != null) {
    return { present: true, permission: j.result.permission };
  }
  return { present: false, reason: "unknown" };
}

async function viewAccessKey(rpc, accountId, publicKey) {
  const j = await nearRpc(rpc, "query", {
    request_type: "view_access_key",
    finality: "final",
    account_id: accountId,
    public_key: publicKey,
  });
  return keyPresent(j);
}

/**
 * Independent startup checks required before any mainnet agent service use.
 */
export async function validateMainnetAgentStartup(opts = {}) {
  const env = opts.env || process.env;
  const ids = { ...MAINNET_IDENTITIES, ...(opts.identities || {}) };
  const network =
    String(env.NIO_NETWORK || env.NEAR_NETWORK || "").toLowerCase() || "mainnet";

  const failures = [];
  const push = (code, ok, detail = {}) => {
    if (!ok) failures.push({ code, ...detail });
    return { code, ok, ...detail };
  };

  const networkCheck = push(
    "network_mainnet",
    network === "mainnet",
    { network }
  );
  if (network !== "mainnet") {
    return {
      ok: false,
      reason: "wrong_network",
      checks: [networkCheck],
      failures,
    };
  }

  try {
    assertNetworkIsolation(MAINNET, { allowMainnet: true });
  } catch (e) {
    failures.push({ code: "network_isolation", detail: String(e.message || e) });
    return { ok: false, reason: "network_isolation", failures };
  }

  let cred;
  try {
    cred = loadAgentOpsCredentials({
      env,
      path: opts.keyPath,
      accountId: ids.agent,
      expectedPublicKey: ids.ops_public_key,
    });
  } catch (e) {
    const code = e.code || "credential_error";
    failures.push({ code, message: e.message });
    return { ok: false, reason: code, failures, checks: [networkCheck] };
  }

  const rpc = opts.rpc || (await pickRpc(MAINNET.near.rpcs));
  const pub = cred.public_key;

  const onAgent = await viewAccessKey(rpc, ids.agent, pub);
  const onOwner = await viewAccessKey(rpc, ids.owner, pub);
  const onPolicy = await viewAccessKey(rpc, ids.policy, pub);

  const checks = [
    networkCheck,
    push("ops_public_key_match", pub === ids.ops_public_key, { public_key: pub }),
    push("ops_installed_on_agent", onAgent.present === true, onAgent),
    push("ops_absent_on_owner", onOwner.present === false, onOwner),
    push("ops_absent_on_policy", onPolicy.present === false, onPolicy),
  ];

  let ownerOnChain;
  let agentOnChain;
  let paused;
  let autonomous;
  let epoch;
  try {
    ownerOnChain = await viewFunction(rpc, ids.policy, "get_owner", {});
    agentOnChain = await viewFunction(rpc, ids.policy, "get_agent", {});
    paused = await viewFunction(rpc, ids.policy, "get_paused", {});
    autonomous = await viewFunction(rpc, ids.policy, "get_autonomous_trading", {});
    epoch = await viewFunction(rpc, ids.policy, "get_mandate_epoch", {});
  } catch (e) {
    failures.push({ code: "policy_view_failed", detail: String(e.message || e) });
    return { ok: false, reason: "policy_view_failed", failures, checks };
  }

  checks.push(
    push("policy_owner_match", ownerOnChain === ids.owner, {
      on_chain: ownerOnChain,
      expected: ids.owner,
    }),
    push("policy_agent_match", agentOnChain === ids.agent, {
      on_chain: agentOnChain,
      expected: ids.agent,
    }),
    push("policy_paused", paused === true, { paused }),
    push("autonomous_false", autonomous === false, { autonomous_trading: autonomous }),
    push("mandate_epoch_loaded", epoch != null && Number(epoch) >= 1, {
      mandate_epoch: epoch,
    })
  );

  const gates = mainnetExecutionGates(env);
  checks.push(
    push("funded_trading_false", gates.funded_trading === false),
    push("broadcast_disabled", gates.mainnet_broadcast_enabled === false),
    push("autonomous_exec_disabled", gates.autonomous_execution_enabled === false)
  );

  const ok = failures.length === 0;
  return {
    ok,
    reason: ok ? null : failures[0]?.code || "startup_validation_failed",
    failures,
    checks,
    rpc,
    public_key: pub,
    account_id: ids.agent,
    policy: {
      owner: ownerOnChain,
      agent: agentOnChain,
      paused,
      autonomous_trading: autonomous,
      mandate_epoch: epoch,
    },
    gates: {
      funded_trading: gates.funded_trading,
      mainnet_broadcast_enabled: gates.mainnet_broadcast_enabled,
      autonomous_execution_enabled: gates.autonomous_execution_enabled,
    },
    credential: cred.log_safe,
    // keyPair retained only inside createMainnetAgentRuntime
    _cred: ok ? cred : null,
  };
}

/**
 * Construct + locally sign a harmless payload for agent.nishanthb.near.
 * Does NOT broadcast. Does NOT return raw signed bytes to callers by default.
 */
export async function constructLocalAgentSign(cred, opts = {}) {
  const accountId = cred.account_id || MAINNET_IDENTITIES.agent;
  const payload = Buffer.from(
    JSON.stringify({
      kind: "nio_j3_harmless_construction",
      account_id: accountId,
      network: "mainnet",
      broadcast: false,
      nonce: randomBytes(8).toString("hex"),
      ts: new Date().toISOString(),
    })
  );
  const signed = cred.keyPair.sign(payload);
  const verify = nacl.sign.detached.verify(
    payload,
    signed.signature,
    cred.keyPair.getPublicKey().data
  );
  const digest = createHash("sha256").update(payload).digest("hex");

  // Optional: build an unsigned NEAR transfer-of-1-yocto-to-self style action
  // object for schema confidence — never send.
  let nearTxSketch = null;
  if (opts.includeTxSketch) {
    nearTxSketch = {
      signer_id: accountId,
      receiver_id: accountId,
      actions: [{ type: "AddKey_sketch_only", note: "not serialized for broadcast" }],
      broadcast: false,
    };
  }

  return {
    ok: verify,
    account_id: accountId,
    public_key: cred.public_key,
    construction_digest: digest,
    signature_verified: verify,
    broadcast: false,
    near_tx_sketch: nearTxSketch,
    // Explicitly omit signature bytes / private material
  };
}

/**
 * Create a runtime handle. Broadcast helpers always refuse.
 */
export async function createMainnetAgentRuntime(opts = {}) {
  const validation = await validateMainnetAgentStartup(opts);
  if (!validation.ok) {
    return {
      ok: false,
      validation: redactSecrets({ ...validation, _cred: undefined }),
    };
  }
  const cred = validation._cred;
  const rpc = validation.rpc;
  const ids = { ...MAINNET_IDENTITIES, ...(opts.identities || {}) };

  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey("mainnet", ids.agent, cred.keyPair);

  const near = await connect({
    networkId: "mainnet",
    nodeUrl: rpc,
    deps: { keyStore },
  });
  const agentAccount = await near.account(ids.agent);

  const localSign = await constructLocalAgentSign(cred, { includeTxSketch: true });

  async function submitTransaction(_signedOrActions) {
    return guardedMainnetSubmit(async () => {
      throw new Error("unreachable_submit");
    }, opts.env || process.env);
  }

  async function assertMayBroadcast() {
    return assertMainnetBroadcastAllowed(opts.env || process.env);
  }

  return {
    ok: true,
    network: "mainnet",
    rpc,
    identities: {
      owner: ids.owner,
      policy: ids.policy,
      agent: ids.agent,
      portfolio_id: ids.portfolio_id,
    },
    validation: redactSecrets({
      ...validation,
      _cred: undefined,
      checks: validation.checks,
    }),
    local_sign: localSign,
    agentAccount,
    near,
    public_key: cred.public_key,
    submitTransaction,
    assertMayBroadcast,
    gates: validation.gates,
    policy: validation.policy,
    /** View helpers — read only */
    view: (accountId, method, args = {}) => viewFunction(rpc, accountId, method, args),
    viewAccount: (accountId) => viewAccount(rpc, accountId),
  };
}

export { MAINNET_IDENTITIES, mainnetExecutionGates, assertMainnetBroadcastAllowed };
