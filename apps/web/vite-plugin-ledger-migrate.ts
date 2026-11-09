/**
 * Localhost-only software FullAccess signer for Ledger key registration.
 * near-api-js v7 API (KeyPairSigner + Account.addFullAccessKey).
 * Private keys never enter the browser bundle.
 */
import type { Plugin } from "vite";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Account,
  JsonRpcProvider,
  KeyPairSigner,
} from "near-api-js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CREDS = join(ROOT, ".near-credentials", "testnet");
const RPC = "https://rpc.testnet.near.org";

const ALLOWED_ACCOUNTS = new Set([
  "nio-c-owner-857107.testnet",
  "nio-c-policy-857107.testnet",
]);

type Body = {
  action: "add_full_access_key" | "delete_access_key" | "status";
  accountId: string;
  publicKey: string;
  signerAccountId?: string;
};

function readJson(req: import("http").IncomingMessage): Promise<Body> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Body);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function isLocal(req: import("http").IncomingMessage): boolean {
  const host = req.headers.host || "";
  return host.startsWith("localhost:") || host.startsWith("127.0.0.1:");
}

function loadCred(accountId: string) {
  const path = join(CREDS, `${accountId}.json`);
  if (!existsSync(path)) {
    throw new Error(`Missing local credential for ${accountId} (server-side only)`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as {
    account_id: string;
    private_key: string;
    public_key: string;
  };
}

function makeAccount(signerAccountId: string, asAccountId: string) {
  const cred = loadCred(signerAccountId);
  const provider = new JsonRpcProvider({ url: RPC });
  const signer = KeyPairSigner.fromSecretKey(cred.private_key);
  // Bind owner keypair to target account id when adding keys to policy
  // (owner FullAccess is already registered on the policy contract).
  return {
    account: new Account(asAccountId, provider, signer),
    softwarePublicKey: cred.public_key,
    signerAccountId,
  };
}

function txHashFromResult(result: unknown): string {
  const r = result as {
    transaction?: { hash?: string };
    transaction_outcome?: { id?: string };
  };
  return r.transaction?.hash || r.transaction_outcome?.id || "";
}

export function ledgerMigratePlugin(): Plugin {
  return {
    name: "ledger-migrate",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/ledger-migrate")) return next();
        res.setHeader("content-type", "application/json");
        if (!isLocal(req)) {
          res.statusCode = 403;
          res.end(JSON.stringify({ ok: false, error: "localhost only" }));
          return;
        }
        if (req.method === "GET") {
          res.end(
            JSON.stringify({
              ok: true,
              service: "ledger-migrate",
              allowedAccounts: [...ALLOWED_ACCOUNTS],
              note: "Software keys stay on the Vite host; browser never receives private keys.",
            })
          );
          return;
        }
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end(JSON.stringify({ ok: false, error: "POST only" }));
          return;
        }
        try {
          const body = await readJson(req);
          if (!ALLOWED_ACCOUNTS.has(body.accountId)) {
            throw new Error(`accountId not allowed: ${body.accountId}`);
          }
          if (!body.publicKey?.startsWith("ed25519:")) {
            throw new Error("publicKey must be ed25519:...");
          }

          // Prefer owner credentials — they hold FullAccess on both owner and policy.
          const ownerId = "nio-c-owner-857107.testnet";
          const signerId =
            body.accountId === "nio-c-policy-857107.testnet"
              ? ownerId
              : body.signerAccountId || body.accountId;

          if (body.action === "status") {
            const cred = loadCred(signerId);
            res.end(
              JSON.stringify({
                ok: true,
                signerId,
                softwarePublicKey: cred.public_key,
                accountId: body.accountId,
              })
            );
            return;
          }

          if (body.action === "add_full_access_key") {
            const { account, softwarePublicKey } = makeAccount(
              signerId,
              body.accountId
            );
            // Idempotent: if key already present, return ok without re-broadcasting
            const list = await account.getAccessKeyList();
            const exists = (list.keys || []).some(
              (k: { public_key: string }) => k.public_key === body.publicKey
            );
            if (exists) {
              res.end(
                JSON.stringify({
                  ok: true,
                  action: body.action,
                  accountId: body.accountId,
                  publicKey: body.publicKey,
                  tx: null,
                  alreadyPresent: true,
                  signedBySoftwareKey: softwarePublicKey,
                  note: "Ledger key already registered",
                })
              );
              return;
            }
            const result = await account.addFullAccessKey(body.publicKey);
            res.end(
              JSON.stringify({
                ok: true,
                action: body.action,
                accountId: body.accountId,
                publicKey: body.publicKey,
                tx: txHashFromResult(result),
                signedBySoftwareKey: softwarePublicKey,
                note: "ADD_KEY signed by existing software FullAccess — not Ledger",
              })
            );
            return;
          }

          if (body.action === "delete_access_key") {
            res.statusCode = 400;
            res.end(
              JSON.stringify({
                ok: false,
                error:
                  "Software endpoint refuses delete_access_key — use Ledger-signed DELETE_KEY in the wizard (Step 5).",
              })
            );
            return;
          }

          throw new Error(`Unknown action ${body.action}`);
        } catch (e) {
          res.statusCode = 500;
          res.end(
            JSON.stringify({
              ok: false,
              error: e instanceof Error ? e.message : String(e),
            })
          );
        }
      });
    },
  };
}
