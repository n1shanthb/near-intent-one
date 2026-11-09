import { CONFIG } from "./config";
import { HARDWARE_OWNERSHIP } from "../data/evidenceSnapshot";

type KeyRow = { public_key: string; access_key: { permission: string | object } };

async function viewKeys(accountId: string): Promise<KeyRow[]> {
  const res = await fetch(CONFIG.nearRpcPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "nio-keys",
      method: "query",
      params: {
        request_type: "view_access_key_list",
        finality: "final",
        account_id: accountId,
      },
    }),
  });
  const json = (await res.json()) as {
    result?: { keys?: KeyRow[] };
    error?: unknown;
  };
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result?.keys ?? [];
}

function isFullAccess(k: KeyRow): boolean {
  return k.access_key.permission === "FullAccess";
}

/** Live read: confirm Ledger-only FullAccess on owner + policy. */
export async function verifyHardwareOwnershipLive(): Promise<{
  ok: boolean;
  ownerKeys: string[];
  policyKeys: string[];
  detail: string;
}> {
  const expected = HARDWARE_OWNERSHIP.ledgerPublicKey;
  const [ownerKeys, policyKeys] = await Promise.all([
    viewKeys(CONFIG.ownerAccount),
    viewKeys(CONFIG.policyContract),
  ]);
  const ownerFa = ownerKeys.filter(isFullAccess).map((k) => k.public_key);
  const policyFa = policyKeys.filter(isFullAccess).map((k) => k.public_key);
  const ownerOk = ownerFa.length === 1 && ownerFa[0] === expected;
  const policyOk = policyFa.length === 1 && policyFa[0] === expected;
  return {
    ok: ownerOk && policyOk,
    ownerKeys: ownerFa,
    policyKeys: policyFa,
    detail:
      ownerOk && policyOk
        ? "CURRENT LIVE READ: owner + policy FullAccess = Ledger key only"
        : `CURRENT LIVE READ mismatch — owner=[${ownerFa.join(",")}] policy=[${policyFa.join(",")}] expected=${expected}`,
  };
}
