/** Shared NEAR / EVM JSON-RPC helpers for network profiles. */

export async function pickRpc(urls) {
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "status",
          params: [],
        }),
      });
      const j = await r.json();
      if (j.result || !j.error) return url;
    } catch {
      /* next */
    }
  }
  return urls[0];
}

export async function nearRpc(rpc, method, params) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "nio", method, params }),
  });
  return res.json();
}

export async function viewFunction(rpc, accountId, methodName, args = {}) {
  const json = await nearRpc(rpc, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: accountId,
    method_name: methodName,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (json.error) throw new Error(JSON.stringify(json.error));
  if (json.result?.error) throw new Error(String(json.result.error));
  if (!json.result?.result) return null;
  const raw = Buffer.from(json.result.result).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return raw.replace(/^"|"$/g, "");
  }
}

export async function viewAccount(rpc, accountId) {
  const json = await nearRpc(rpc, "query", {
    request_type: "view_account",
    finality: "final",
    account_id: accountId,
  });
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result;
}
