import { PublicKey, KeyType } from "@near-js/crypto";
import {
  actionCreators,
  createTransaction,
  encodeTransaction,
  Signature,
  SignedTransaction,
  type Action,
} from "@near-js/transactions";
import { baseDecode } from "@near-js/utils";
import { Buffer } from "buffer";
import { LedgerClient } from "./ledgerClient";
import {
  getLatestBlockHash,
  sendBroadcastTx,
  viewAccessKey,
} from "./rpc";

function extractTxHash(result: {
  transaction_outcome?: { id?: string };
  transaction?: { hash?: string };
}): string {
  return (
    result.transaction?.hash ||
    result.transaction_outcome?.id ||
    ""
  );
}

function outcomeOk(status: unknown): boolean {
  if (!status || typeof status !== "object") return false;
  const s = status as Record<string, unknown>;
  if ("SuccessValue" in s || "SuccessReceiptId" in s) return true;
  if (s.SuccessValue !== undefined || s.SuccessReceiptId !== undefined) return true;
  return false;
}

export async function signAndSendWithLedger(params: {
  client: LedgerClient;
  derivationPath: string;
  publicKey: string; // ed25519:...
  signerId: string;
  receiverId: string;
  actions: Action[];
}): Promise<{ hash: string; ok: boolean; raw: unknown }> {
  const pk = params.publicKey.startsWith("ed25519:")
    ? params.publicKey
    : `ed25519:${params.publicKey}`;
  const access = await viewAccessKey(params.signerId, pk);
  if (!access) {
    throw new Error(
      `Ledger public key is not registered as FullAccess on ${params.signerId}`
    );
  }
  const blockHash = await getLatestBlockHash();
  const publicKey = PublicKey.fromString(pk);
  const tx = createTransaction(
    params.signerId,
    publicKey,
    params.receiverId,
    BigInt(access.nonce) + 1n,
    params.actions,
    baseDecode(blockHash)
  );
  const encoded = encodeTransaction(tx);
  const sigBytes = await params.client.signTransaction(
    encoded instanceof Uint8Array ? encoded : new Uint8Array(encoded),
    params.derivationPath
  );
  if (sigBytes.length !== 64) {
    throw new Error(`Unexpected Ledger signature length ${sigBytes.length}`);
  }
  const signed = new SignedTransaction({
    transaction: tx,
    signature: new Signature({
      keyType: KeyType.ED25519,
      data: new Uint8Array(sigBytes),
    }),
  });
  const bytes = encodeTransaction(signed);
  const b64 = Buffer.from(bytes).toString("base64");
  const raw = await sendBroadcastTx(b64);
  const hash = extractTxHash(raw as { transaction_outcome?: { id?: string }; transaction?: { hash?: string } });
  const status = (raw as { status?: unknown }).status;
  return { hash, ok: outcomeOk(status) || Boolean(hash), raw };
}

export function functionCallAction(
  methodName: string,
  args: Record<string, unknown>,
  gas = 50_000_000_000_000n,
  deposit = 0n
): Action {
  return actionCreators.functionCall(
    methodName,
    args,
    gas,
    deposit
  );
}

export function deleteKeyAction(publicKey: string): Action {
  return actionCreators.deleteKey(PublicKey.fromString(publicKey));
}

export { actionCreators };
