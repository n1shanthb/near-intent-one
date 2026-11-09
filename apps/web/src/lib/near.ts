import { CONFIG } from "./config";

async function rpc(method: string, params: unknown) {
  const res = await fetch(CONFIG.nearRpcPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "nio", method, params }),
  });
  const json = (await res.json()) as {
    result?: { result?: number[] };
    error?: unknown;
  };
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result;
}

export async function viewFunction<T = unknown>(
  methodName: string,
  args: Record<string, unknown> = {},
  contractId = CONFIG.policyContract
): Promise<T> {
  const result = await rpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: contractId,
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

export type ExposureSnapshot = {
  reserved_pending_exposure: string;
  realized_exposure: string;
  revoked: boolean;
  mandate_epoch: number;
  unresolved_pending: number;
  signing_revoked?: boolean;
  economically_settled?: boolean;
};

export type PendingOp = {
  epoch: number;
  amount_in: string;
  asset_in: string;
  asset_out: string;
  destination: string;
  min_amount_out: string;
  payload_commitment: string;
  signing_state: string;
  settlement_state: string;
  intent_deadline?: number;
};

export async function loadMandateViews() {
  const [owner, agent, epoch, revoked, exposure, path] = await Promise.all([
    viewFunction<string>("get_owner"),
    viewFunction<string>("get_agent"),
    viewFunction<number | string>("get_mandate_epoch"),
    viewFunction<{ revoked: boolean; mandate_epoch: number }>(
      "get_revocation_status"
    ).catch(() => null),
    viewFunction<ExposureSnapshot>("get_exposure_snapshot").catch(() => null),
    viewFunction<string>("get_derivation_path").catch(() => null),
  ]);
  return { owner, agent, epoch, revoked, exposure, path };
}
