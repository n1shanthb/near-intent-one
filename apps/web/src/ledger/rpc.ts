import { CONFIG } from "../lib/config";

export type AccessKeyInfo = {
  public_key: string;
  permission: "FullAccess" | Record<string, unknown>;
};

async function rpc<T = unknown>(method: string, params: unknown): Promise<T> {
  const res = await fetch(CONFIG.nearRpcPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "ledger", method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: unknown };
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result as T;
}

export async function viewAccessKeyList(accountId: string): Promise<AccessKeyInfo[]> {
  const result = await rpc<{ keys?: Array<{ public_key: string; access_key?: { permission: unknown } }> }>(
    "query",
    {
      request_type: "view_access_key_list",
      finality: "final",
      account_id: accountId,
    }
  );
  return (result?.keys || []).map((k) => ({
    public_key: k.public_key,
    permission:
      k.access_key?.permission === "FullAccess"
        ? "FullAccess"
        : ((k.access_key?.permission as Record<string, unknown>) ?? { FunctionCall: true }),
  }));
}

export async function viewAccessKey(
  accountId: string,
  publicKey: string
): Promise<{ nonce: number } | null> {
  try {
    const result = await rpc<{ nonce: number; permission: unknown }>("query", {
      request_type: "view_access_key",
      finality: "final",
      account_id: accountId,
      public_key: publicKey,
    });
    return { nonce: Number(result.nonce) };
  } catch {
    return null;
  }
}

export async function getLatestBlockHash(): Promise<string> {
  const status = await rpc<{ sync_info?: { latest_block_hash?: string } }>("status", []);
  const hash = status?.sync_info?.latest_block_hash;
  if (!hash) throw new Error("Could not fetch latest block hash");
  return hash;
}

export async function viewFunctionJson<T>(
  accountId: string,
  methodName: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const result = await rpc<{ result?: number[] }>("query", {
    request_type: "call_function",
    finality: "final",
    account_id: accountId,
    method_name: methodName,
    args_base64: btoa(JSON.stringify(args)),
  });
  if (!result?.result) throw new Error(`empty view ${methodName}`);
  const raw = new TextDecoder().decode(Uint8Array.from(result.result));
  try {
    return JSON.parse(raw) as T;
  } catch {
    return raw as T;
  }
}

export async function sendBroadcastTx(signedTxBase64: string): Promise<{
  transaction_outcome?: { id?: string };
  status?: unknown;
  transaction?: { hash?: string };
}> {
  // Prefer send_tx; fall back to broadcast_tx_commit
  try {
    return await rpc("send_tx", {
      signed_tx_base64: signedTxBase64,
      wait_until: "FINAL",
    });
  } catch {
    return await rpc("broadcast_tx_commit", [signedTxBase64]);
  }
}

export function fullAccessKeys(keys: AccessKeyInfo[]): AccessKeyInfo[] {
  return keys.filter((k) => k.permission === "FullAccess");
}

export function hasPublicKey(keys: AccessKeyInfo[], publicKey: string): boolean {
  const normalized = publicKey.startsWith("ed25519:") ? publicKey : `ed25519:${publicKey}`;
  return keys.some((k) => k.public_key === normalized);
}

export function txExplorerUrl(hash: string): string {
  return `${CONFIG.nearblocks}/txns/${hash}`;
}
