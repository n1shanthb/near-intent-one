#!/usr/bin/env node
/**
 * Gate C: Prove Direct Intent Compatibility (Tidepool testnet verifier).
 * Preserves Gate B evidence under evidence/live/; writes gate-c-* artifacts.
 *
 * Ledger: NONE (software faucet keys). No mainnet funds.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import * as nearAPI from "near-api-js";
import bs58 from "bs58";
import {
  eip191DigestHex,
  evmAddressFromNearSecpKey,
  mpcSigToIntentsEncoding,
  recoverAddressFromErc191,
  buildIntentPayloadObject,
  serializeIntentPayload,
} from "../packages/intents-codec/eip191.mjs";

const { connect, keyStores, KeyPair } = nearAPI;
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CREDS = join(ROOT, ".near-credentials", "testnet");
const EVIDENCE = join(ROOT, "evidence", "live");
const MPC = "v1.signer-prod.testnet";
const RPC = "https://rpc.testnet.near.org";
const NETWORK = "testnet";
const VERIFIER = "verifier.tidepool-sandbox.testnet";
const TIDEPOOL = "https://www.usetidepool.tech";
const ASSET = "nep141:usdc.tidepool-sandbox.testnet";
const PORTFOLIO = "gatec1";

mkdirSync(EVIDENCE, { recursive: true });

function save(name, obj) {
  const p = join(EVIDENCE, name);
  writeFileSync(p, JSON.stringify(obj, null, 2));
  console.log("wrote", p);
  return p;
}

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "gate-c", method, params }),
  });
  return res.json();
}

async function viewFunction(accountId, methodName, args = {}) {
  const json = await rpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: accountId,
    method_name: methodName,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (json.error) throw new Error(JSON.stringify(json.error));
  const raw = Buffer.from(json.result.result).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function faucetCreate(accountId, publicKey) {
  const res = await fetch("https://helper.nearprotocol.com/account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }),
  });
  const body = await res.json().catch(async () => res.text());
  return { status: res.status, ok: res.ok, body };
}

function findWasm() {
  const p = join(ROOT, "contracts", "policy", "target", "wasm32-unknown-unknown", "release", "policy.wasm");
  if (!existsSync(p)) throw new Error("missing policy.wasm");
  return p;
}

function extractSig(fullTx) {
  const out = { found: false };
  const outcomes = fullTx?.result?.receipts_outcome || [];
  for (const r of outcomes) {
    const sv = r?.outcome?.status?.SuccessValue;
    if (!sv) continue;
    try {
      const decoded = Buffer.from(sv, "base64").toString("utf8");
      if (decoded.includes("Secp256k1") || decoded.includes("big_r")) {
        out.found = true;
        out.signature_json = JSON.parse(decoded);
        out.executor_id = r.outcome.executor_id;
      }
    } catch {
      /* ignore */
    }
  }
  const top = fullTx?.result?.status?.SuccessValue;
  if (!out.found && top) {
    try {
      const decoded = Buffer.from(top, "base64").toString("utf8");
      if (decoded.includes("Secp256k1")) {
        out.found = true;
        out.signature_json = JSON.parse(decoded);
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

function classifyVerifierError(message) {
  const m = String(message || "").toLowerCase();
  if (/insufficient balance|overflow/.test(m)) return "INSUFFICIENT_BALANCE_OR_OVERFLOW";
  if (/invalid signature|failed to verify|signature|recover|ecrecover|unauthorized/.test(m))
    return "SIGNATURE_REJECTION";
  if (/deadline|expired|nonce/.test(m)) return "NONCE_OR_DEADLINE";
  if (/not registered|public key/.test(m)) return "KEY_REGISTRATION";
  return "OTHER_OR_UNKNOWN";
}

async function main() {
  const evidence = {
    gate: "C",
    started_at: new Date().toISOString(),
    network: NETWORK,
    verifier: VERIFIER,
    mpc_signer: MPC,
    ledger: "NONE — software faucet keys; no mainnet funds",
    gate_b_preserved: existsSync(join(EVIDENCE, "gate-b-evidence.json")),
    steps: {},
    adversarial: {},
    gates: {},
  };

  // ── Create fresh accounts (preserve Gate B accounts/evidence) ─────────
  const suffix = randomBytes(3).toString("hex");
  const names = {
    owner: `nio-c-owner-${suffix}.testnet`,
    agent: `nio-c-agent-${suffix}.testnet`,
    contract: `nio-c-policy-${suffix}.testnet`,
  };
  mkdirSync(CREDS, { recursive: true });
  const accountsMeta = {};
  for (const [role, accountId] of Object.entries(names)) {
    const kp = KeyPair.fromRandom("ed25519");
    const cred = {
      account_id: accountId,
      public_key: kp.getPublicKey().toString(),
      private_key: kp.toString(),
      role,
    };
    writeFileSync(join(CREDS, `${accountId}.json`), JSON.stringify(cred, null, 2));
    const f = await faucetCreate(accountId, cred.public_key);
    accountsMeta[role] = { account_id: accountId, public_key: cred.public_key, faucet: f.status };
    console.log(role, accountId, "faucet", f.status);
    await new Promise((r) => setTimeout(r, 1500));
  }
  evidence.accounts = accountsMeta;
  save("gate-c-wallets.json", accountsMeta);

  const keyStore = new keyStores.InMemoryKeyStore();
  for (const role of Object.keys(names)) {
    const id = names[role];
    const cred = JSON.parse(readFileSync(join(CREDS, `${id}.json`), "utf8"));
    await keyStore.setKey(NETWORK, id, KeyPair.fromString(cred.private_key));
  }
  const near = await connect({ networkId: NETWORK, nodeUrl: RPC, deps: { keyStore } });
  const owner = await near.account(names.owner);
  const agent = await near.account(names.agent);
  const contractAccount = await near.account(names.contract);
  const contractId = names.contract;

  // ── Deploy + init ─────────────────────────────────────────────────────
  const wasm = readFileSync(findWasm());
  const deployRes = await contractAccount.deployContract(wasm);
  evidence.steps.deploy = {
    ok: true,
    contract_id: contractId,
    transaction_hash: deployRes.transaction.hash,
    wasm_bytes: wasm.length,
  };
  save("gate-c-02-deploy.json", evidence.steps.deploy);

  const initRes = await contractAccount.functionCall({
    contractId,
    methodName: "new",
    args: {
      owner: names.owner,
      agent: names.agent,
      mpc_signer: MPC,
      portfolio_id: PORTFOLIO,
      verifying_contract: VERIFIER,
      limits: {
        max_trade_value: "10000000",
        daily_turnover_limit: "100000000",
        max_pending_exposure: "10000000",
        max_slippage_bps: 100,
        allowed_assets: [ASSET, "USDC", "NEAR"],
        allowed_destinations: [
          "bob.testnet",
          names.owner,
          "0x0000000000000000000000000000000000000001",
        ],
        valid_until: "1893456000000000000",
      },
    },
    gas: BigInt("50000000000000"),
    attachedDeposit: 0n,
  });
  evidence.steps.init = { ok: true, transaction_hash: initRes.transaction.hash };
  save("gate-c-03-init.json", evidence.steps.init);

  const path = await viewFunction(contractId, "get_derivation_path");
  const epoch = await viewFunction(contractId, "get_mandate_epoch");
  evidence.steps.path = { path, epoch, expected: `trading/v1/portfolio/${PORTFOLIO}` };
  save("gate-c-04-path.json", evidence.steps.path);

  const derivedNearKey = await viewFunction(MPC, "derived_public_key", {
    path,
    predecessor: contractId,
    domain_id: 0,
  });
  const signerId = evmAddressFromNearSecpKey(derivedNearKey);
  evidence.steps.derived = { derivedNearKey, signerId, path, predecessor: contractId };
  save("gate-c-05-derived-evm.json", evidence.steps.derived);

  const setSigner = await owner.functionCall({
    contractId,
    methodName: "set_intents_signer_id",
    args: { intents_signer_id: signerId },
    gas: BigInt("30000000000000"),
    attachedDeposit: 0n,
  });
  evidence.steps.set_intents_signer = {
    ok: true,
    transaction_hash: setSigner.transaction.hash,
    signerId,
  };
  save("gate-c-06-set-signer.json", evidence.steps.set_intents_signer);

  // ── Build harmless transfer intent ────────────────────────────────────
  const nonce = Buffer.from(randomBytes(32)).toString("base64");
  const deadlineIso = new Date(Date.now() + 15 * 60_000).toISOString();
  const intentObj = buildIntentPayloadObject({
    signerId,
    verifyingContract: VERIFIER,
    deadlineIso,
    nonceBase64: nonce,
    intents: [
      {
        intent: "transfer",
        receiver_id: "bob.testnet",
        tokens: { [ASSET]: "1" },
      },
    ],
  });
  const payloadJson = serializeIntentPayload(intentObj);
  const digestHex = eip191DigestHex(payloadJson);
  evidence.steps.payload = { payloadJson, digestHex, intentObj };
  save("gate-c-07-payload.json", evidence.steps.payload);

  // Cross-check contract digest helper
  const onchainDigest = await viewFunction(contractId, "eip191_digest", {
    payload_json: payloadJson,
  });
  evidence.steps.digest_parity = {
    offchain: digestHex,
    onchain: onchainDigest,
    match: digestHex === onchainDigest,
  };
  save("gate-c-08-digest-parity.json", evidence.steps.digest_parity);

  // ── propose_intent + request_signature ────────────────────────────────
  const opId = `gatec-${Date.now()}`;
  const propose = await agent.functionCall({
    contractId,
    methodName: "propose_intent",
    args: {
      operation_id: opId,
      payload_json: payloadJson,
      expected_epoch: epoch,
    },
    gas: BigInt("100000000000000"),
    attachedDeposit: 0n,
  });
  evidence.steps.propose_intent = {
    ok: true,
    operation_id: opId,
    transaction_hash: propose.transaction.hash,
    logs: propose.receipts_outcome?.flatMap((r) => r.outcome.logs) ?? [],
  };
  save("gate-c-09-propose-intent.json", evidence.steps.propose_intent);

  let signRes;
  let signErr = null;
  try {
    signRes = await agent.functionCall({
      contractId,
      methodName: "request_signature",
      args: { operation_id: opId },
      gas: BigInt("300000000000000"),
      attachedDeposit: 1n,
    });
  } catch (e) {
    signErr = String(e);
  }
  const signTx = signRes?.transaction?.hash;
  evidence.steps.request_signature = {
    ok: !!signRes && !signErr,
    transaction_hash: signTx,
    error: signErr,
    logs: signRes?.receipts_outcome?.flatMap((r) => r.outcome.logs) ?? [],
  };
  save("gate-c-10-request-signature.json", evidence.steps.request_signature);

  const fullTx = signTx
    ? await rpc("EXPERIMENTAL_tx_status", [signTx, names.agent])
    : null;
  if (fullTx) save("gate-c-11-full-tx.json", fullTx);
  const extracted = extractSig(fullTx);
  evidence.steps.signature_extraction = extracted;
  save("gate-c-12-signature.json", extracted);

  let intentsSig = null;
  let recovered = null;
  if (extracted.found) {
    intentsSig = mpcSigToIntentsEncoding(extracted.signature_json);
    recovered = recoverAddressFromErc191(payloadJson, intentsSig);
    evidence.steps.intents_encoding = {
      signature: intentsSig,
      recovered_address: recovered,
      matches_signer_id: recovered.toLowerCase() === signerId.toLowerCase(),
    };
  } else {
    evidence.steps.intents_encoding = { error: "no MPC signature extracted" };
  }
  save("gate-c-13-intents-encoding.json", evidence.steps.intents_encoding);

  evidence.gates.C_mpc_signs_eip191_digest = {
    status:
      evidence.steps.request_signature.ok &&
      extracted.found &&
      evidence.steps.digest_parity.match &&
      evidence.steps.intents_encoding?.matches_signer_id
        ? "PASS"
        : "FAIL",
  };

  // ── Submit to Tidepool / execute_intents ──────────────────────────────
  const signedData = {
    standard: "erc191",
    payload: payloadJson,
    signature: intentsSig,
  };
  evidence.steps.signedData = signedData;

  let submitRes = null;
  if (intentsSig) {
    const r = await fetch(`${TIDEPOOL}/v0/submit-intent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "swap_transfer", signedData }),
    });
    const text = await r.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    submitRes = {
      http_status: r.status,
      body,
      classification: r.ok
        ? "ACCEPTED_EXECUTED_OR_QUEUED"
        : classifyVerifierError(body?.message || text),
    };
  } else {
    submitRes = { skipped: true, reason: "no signature" };
  }
  evidence.steps.tidepool_submit_intent = submitRes;
  save("gate-c-14-tidepool-submit.json", submitRes);

  // simulate_intents (view) — separates signature verify from settlement effects
  let simRes = null;
  if (intentsSig) {
    try {
      const sim = await viewFunction(VERIFIER, "simulate_intents", {
        signed: [signedData],
      });
      simRes = { ok: true, result: sim, classification: "SIMULATION_RETURNED" };
      const blob = JSON.stringify(sim).toLowerCase();
      if (/insufficient|overflow|invariant/.test(blob)) {
        simRes.classification = "INSUFFICIENT_BALANCE_OR_OVERFLOW";
      }
    } catch (e) {
      const msg = String(e);
      simRes = { ok: false, error: msg, classification: classifyVerifierError(msg) };
    }
  }
  evidence.steps.simulate_intents = simRes;
  save("gate-c-15a-simulate-intents.json", simRes);

  // Direct execute_intents via a funded NEAR account (gas payer ≠ ERC-191 signer)
  let execRes = null;
  if (intentsSig) {
    try {
      const outcome = await agent.functionCall({
        contractId: VERIFIER,
        methodName: "execute_intents",
        args: { signed: [signedData] },
        gas: BigInt("100000000000000"),
        attachedDeposit: 0n,
      });
      execRes = {
        ok: true,
        transaction_hash: outcome.transaction.hash,
        status: outcome.status,
        logs: outcome.receipts_outcome?.flatMap((r) => r.outcome.logs) ?? [],
        classification: "ACCEPTED_ON_CHAIN",
      };
    } catch (e) {
      const msg = String(e);
      execRes = {
        ok: false,
        error: msg,
        classification: classifyVerifierError(msg),
        transaction_hash: (msg.match(/([A-Za-z0-9]{43,44})/) || [])[1] || null,
      };
    }
  }
  evidence.steps.execute_intents = execRes;
  save("gate-c-15-execute-intents.json", execRes);

  const verifierAcceptedSig =
    submitRes?.classification === "INSUFFICIENT_BALANCE_OR_OVERFLOW" ||
    submitRes?.classification === "ACCEPTED_EXECUTED_OR_QUEUED" ||
    execRes?.classification === "INSUFFICIENT_BALANCE_OR_OVERFLOW" ||
    execRes?.classification === "ACCEPTED_ON_CHAIN" ||
    simRes?.classification === "INSUFFICIENT_BALANCE_OR_OVERFLOW" ||
    simRes?.classification === "SIMULATION_RETURNED";

  const verifierRejectedSig =
    submitRes?.classification === "SIGNATURE_REJECTION" ||
    execRes?.classification === "SIGNATURE_REJECTION" ||
    simRes?.classification === "SIGNATURE_REJECTION";

  evidence.gates.C_verifier_accepts_mpc_signed_intent = {
    status: verifierAcceptedSig ? "PASS" : verifierRejectedSig ? "FAIL" : "BLOCKED",
    note: verifierAcceptedSig
      ? "Verifier processed signature; failure (if any) is balance/execution — not signature rejection."
      : verifierRejectedSig
        ? "Verifier rejected the signature itself."
        : "Could not distinguish: see simulate/execute/submit traces.",
    tidepool_classification: submitRes?.classification,
    simulate_classification: simRes?.classification,
    execute_intents_classification: execRes?.classification,
  };

  // ── Adversarial tests (off-chain classify + on-chain propose rejects) ─
  async function tryPropose(label, mutate) {
    const bad = structuredClone(intentObj);
    mutate(bad);
    const pj = serializeIntentPayload(bad);
    try {
      await agent.functionCall({
        contractId,
        methodName: "propose_intent",
        args: {
          operation_id: `adv-${label}-${Date.now()}`,
          payload_json: pj,
          expected_epoch: await viewFunction(contractId, "get_mandate_epoch"),
        },
        gas: BigInt("80000000000000"),
        attachedDeposit: 0n,
      });
      return { label, ok: true, expected_fail: true };
    } catch (e) {
      return { label, ok: false, expected_fail: true, error: String(e).slice(0, 500) };
    }
  }

  evidence.adversarial.wrong_signer = await tryPropose("wrong-signer", (o) => {
    o.signer_id = "0x0000000000000000000000000000000000000001";
  });
  evidence.adversarial.wrong_recipient = await tryPropose("wrong-recipient", (o) => {
    o.intents[0].receiver_id = "eve.testnet";
  });
  evidence.adversarial.unsupported_asset = await tryPropose("bad-asset", (o) => {
    o.intents[0].tokens = { "nep141:scam.testnet": "1" };
  });
  evidence.adversarial.expired_deadline = await tryPropose("expired", (o) => {
    o.deadline = "2020-01-01T00:00:00.000Z";
  });

  // Tampered payload: sign good payload then alter before submit
  if (intentsSig) {
    const tampered = payloadJson.replace('"1"', '"2"');
    const r = await fetch(`${TIDEPOOL}/v0/submit-intent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "swap_transfer",
        signedData: { standard: "erc191", payload: tampered, signature: intentsSig },
      }),
    });
    const text = await r.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    evidence.adversarial.tampered_payload_submit = {
      http_status: r.status,
      body,
      classification: classifyVerifierError(body?.message || text),
      expect: "SIGNATURE_REJECTION",
    };
  }

  // Wrong nonce submit: rebuild object with different nonce, reuse signature
  if (intentsSig) {
    const wrongNonceObj = { ...intentObj, nonce: Buffer.from(randomBytes(32)).toString("base64") };
    const wrongPayload = serializeIntentPayload(wrongNonceObj);
    const r = await fetch(`${TIDEPOOL}/v0/submit-intent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "swap_transfer",
        signedData: { standard: "erc191", payload: wrongPayload, signature: intentsSig },
      }),
    });
    const text = await r.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    evidence.adversarial.wrong_nonce_submit = {
      http_status: r.status,
      classification: classifyVerifierError(body?.message || text),
      body,
    };
  }

  // Post-revocation signing
  const revokeRes = await owner.functionCall({
    contractId,
    methodName: "revoke",
    args: {},
    gas: BigInt("30000000000000"),
    attachedDeposit: 0n,
  });
  evidence.steps.revoke = { transaction_hash: revokeRes.transaction.hash };
  const pathAfter = await viewFunction(contractId, "get_derivation_path");
  const epochAfter = await viewFunction(contractId, "get_mandate_epoch");
  evidence.steps.path_after_revoke = {
    path: pathAfter,
    epoch: epochAfter,
    path_unchanged: pathAfter === path,
  };
  save("gate-c-16-path-after-revoke.json", evidence.steps.path_after_revoke);

  let postRevoke;
  try {
    await agent.functionCall({
      contractId,
      methodName: "propose_intent",
      args: {
        operation_id: `post-revoke-${Date.now()}`,
        payload_json: payloadJson,
        expected_epoch: epochAfter,
      },
      gas: BigInt("80000000000000"),
      attachedDeposit: 0n,
    });
    postRevoke = { ok: true };
  } catch (e) {
    postRevoke = { ok: false, error: String(e).slice(0, 500) };
  }
  evidence.adversarial.post_revocation_propose = postRevoke;
  save("gate-c-17-adversarial.json", evidence.adversarial);

  evidence.gates.C_stable_path = {
    status: path === `trading/v1/portfolio/${PORTFOLIO}` && pathAfter === path ? "PASS" : "FAIL",
    path,
    path_after_revoke: pathAfter,
  };
  evidence.gates.C_adversarial_policy = {
    status:
      !evidence.adversarial.wrong_signer.ok &&
      !evidence.adversarial.wrong_recipient.ok &&
      !evidence.adversarial.unsupported_asset.ok &&
      !evidence.adversarial.expired_deadline.ok &&
      !postRevoke.ok
        ? "PASS"
        : "FAIL",
  };

  // ── Revocation model investigation ────────────────────────────────────
  evidence.revocation_model = {
    implicit_erc191: {
      identity: "EVM address recovered from secp256k1 signature (no add_public_key)",
      key_revocation_on_verifier:
        "No public_key registration step for ERC-191. The address IS the account. There is no unregister of an 'intrinsic' key because verification is recover(payload,sig)==signer_id.",
      practical_revocation:
        "Policy-contract revoke stops NEW MPC signatures. Already-published signatures remain valid until deadline/nonce consumption. Named-account NEP-413 model CAN remove_public_key on verifier — that does NOT apply to pure ERC-191 implicit addresses.",
    },
    named_account_nep413: {
      enables_verifier_key_revocation: true,
      mechanism: "add_public_key / remove_public_key on verifier for the NEAR account id",
      tradeoff: "Requires NEP-413 ed25519 (or registered key), not the Chain-Signatures secp256k1 ERC-191 path used here",
    },
    recommendation:
      "Keep ERC-191 for Chain Signatures. Enforce revoke via contract epoch + short deadlines + pending exposure. Do not claim verifier-side key deletion for implicit EVM identities.",
  };
  save("gate-c-18-revocation-model.json", evidence.revocation_model);

  evidence.finished_at = new Date().toISOString();
  save("gate-c-evidence.json", evidence);
  console.log("\n=== GATE C SUMMARY ===");
  console.log(JSON.stringify(evidence.gates, null, 2));
  return evidence;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
