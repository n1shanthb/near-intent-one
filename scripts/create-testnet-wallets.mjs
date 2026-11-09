#!/usr/bin/env node
/**
 * Create owner + agent + contract named accounts on NEAR testnet via faucet.
 * Keys under .near-credentials/testnet (gitignored). Testnet only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { KeyPair } from "near-api-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CREDS = join(ROOT, ".near-credentials", "testnet");
const RPC = "https://rpc.testnet.near.org";

// Try known faucet endpoints in order.
const FAUCETS = [
  "https://helper.nearprotocol.com/account",
  "https://helper.testnet.near.org/account",
];

const suffix = randomBytes(3).toString("hex");
const NAMES = {
  owner: `nio-owner-${suffix}.testnet`,
  agent: `nio-agent-${suffix}.testnet`,
  contract: `nio-policy-${suffix}.testnet`,
};

async function faucetCreate(accountId, publicKey) {
  const errors = [];
  for (const url of FAUCETS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          newAccountId: accountId,
          newAccountPublicKey: publicKey,
        }),
      });
      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      if (res.ok) return { status: res.status, ok: true, body, faucet: url };
      errors.push({ faucet: url, status: res.status, body });
    } catch (e) {
      errors.push({ faucet: url, error: String(e) });
    }
  }
  return { status: 0, ok: false, body: errors, faucet: null };
}

async function viewAccount(accountId) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "acc",
      method: "query",
      params: {
        request_type: "view_account",
        finality: "final",
        account_id: accountId,
      },
    }),
  });
  return res.json();
}

mkdirSync(CREDS, { recursive: true });
const manifest = {
  network: "testnet",
  created_at: new Date().toISOString(),
  accounts: {},
};

for (const [role, accountId] of Object.entries(NAMES)) {
  const kp = KeyPair.fromRandom("ed25519");
  const publicKey = kp.getPublicKey().toString();
  const privateKey = kp.toString();
  const credPath = join(CREDS, `${accountId}.json`);
  writeFileSync(
    credPath,
    JSON.stringify(
      {
        account_id: accountId,
        public_key: publicKey,
        private_key: privateKey,
        role,
      },
      null,
      2
    )
  );
  console.log(`\n[${role}] creating ${accountId} pk=${publicKey}`);
  const result = await faucetCreate(accountId, publicKey);
  console.log(JSON.stringify(result, null, 2));
  // Brief wait for indexing
  await new Promise((r) => setTimeout(r, 2000));
  const view = await viewAccount(accountId);
  const amount = view?.result?.amount ?? null;
  const err = view?.error ?? null;
  console.log(`[${role}] balance yoctoNEAR: ${amount}${err ? " err=" + JSON.stringify(err) : ""}`);
  manifest.accounts[role] = {
    account_id: accountId,
    public_key: publicKey,
    credentials: credPath.replace(/\\/g, "/"),
    faucet: result,
    balance_yocto: amount,
    view_error: err,
  };
}

const out = join(ROOT, "evidence", "live", "wallets.json");
writeFileSync(out, JSON.stringify(manifest, null, 2));
console.log(`\nWrote ${out}`);

const failed = Object.values(manifest.accounts).filter((a) => !a.balance_yocto);
if (failed.length) {
  console.error("\nFAUCET/ACCOUNT FAILURES:", failed.map((a) => a.account_id));
  process.exit(1);
}
