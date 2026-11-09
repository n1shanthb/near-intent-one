#!/usr/bin/env node
/** On-chain adversarial: tampered payload / wrong nonce against Tidepool verifier. */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import * as nearAPI from "near-api-js";

const { connect, keyStores, KeyPair } = nearAPI;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = join(ROOT, "evidence", "live");
const CREDS = join(ROOT, ".near-credentials", "testnet");
const VERIFIER = "verifier.tidepool-sandbox.testnet";
const NETWORK = "testnet";
const RPC = "https://rpc.testnet.near.org";

const ev = JSON.parse(readFileSync(join(EVIDENCE, "gate-c-evidence.json"), "utf8"));
const agentId = ev.accounts.agent.account_id;
const cred = JSON.parse(readFileSync(join(CREDS, `${agentId}.json`), "utf8"));
const signed = ev.steps.signedData;
const payload = signed.payload;
const signature = signed.signature;

const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey(NETWORK, agentId, KeyPair.fromString(cred.private_key));
const near = await connect({ networkId: NETWORK, nodeUrl: RPC, deps: { keyStore } });
const agent = await near.account(agentId);

function classify(msg) {
  const m = String(msg || "").toLowerCase();
  if (/insufficient balance|overflow/.test(m)) return "INSUFFICIENT_BALANCE_OR_OVERFLOW";
  if (/invalid signature|failed to verify|signature|recover|ecrecover|unauthorized|public key/.test(m))
    return "SIGNATURE_REJECTION";
  if (/deadline|expired|nonce|replay/.test(m)) return "NONCE_OR_DEADLINE";
  return "OTHER_OR_UNKNOWN";
}

async function tryExec(label, signedData) {
  try {
    const outcome = await agent.functionCall({
      contractId: VERIFIER,
      methodName: "execute_intents",
      args: { signed: [signedData] },
      gas: BigInt("100000000000000"),
      attachedDeposit: 0n,
    });
    return {
      label,
      ok: true,
      tx: outcome.transaction.hash,
      classification: "ACCEPTED_ON_CHAIN",
    };
  } catch (e) {
    return {
      label,
      ok: false,
      error: String(e).slice(0, 800),
      classification: classify(String(e)),
    };
  }
}

const tampered = payload.replace('"1"', '"9"');
const wrongNonce = JSON.parse(payload);
wrongNonce.nonce = Buffer.from(randomBytes(32)).toString("base64");

const results = {
  tampered_payload: await tryExec("tampered", {
    standard: "erc191",
    payload: tampered,
    signature,
  }),
  wrong_nonce: await tryExec("wrong-nonce", {
    standard: "erc191",
    payload: JSON.stringify(wrongNonce),
    signature,
  }),
};

writeFileSync(
  join(EVIDENCE, "gate-c-19-adversarial-onchain.json"),
  JSON.stringify(results, null, 2)
);
console.log(JSON.stringify(results, null, 2));
