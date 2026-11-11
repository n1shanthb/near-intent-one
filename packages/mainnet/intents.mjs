/**
 * Production NEAR Intents via official 1Click API.
 * Tidepool/testnet contracts are NEVER used here.
 * Funded quotes (dry:false) require separate authorization.
 */
import { MAINNET, assertNetworkIsolation } from "../networks/profiles.mjs";

const DEFAULT_BASE = MAINNET.intents.apiBase;

function authHeaders(token) {
  const h = {
    "content-type": "application/json",
    accept: "application/json",
    // Official docs accept either header for partner JWT.
  };
  if (token) {
    h.authorization = `Bearer ${token}`;
    h["x-api-key"] = token;
  }
  return h;
}

export async function fetchProductionTokens({
  baseUrl = DEFAULT_BASE,
  token = process.env.NIO_1CLICK_JWT,
} = {}) {
  assertNetworkIsolation(MAINNET, { allowMainnet: true });
  const res = await fetch(`${baseUrl}/v0/tokens`, {
    headers: authHeaders(token),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      reason: res.status === 401 ? "jwt_required" : "tokens_http_error",
      body,
      api: baseUrl,
    };
  }
  const list = Array.isArray(body) ? body : body.tokens || body;
  return {
    ok: true,
    api: baseUrl,
    count: Array.isArray(list) ? list.length : null,
    tokens: list,
    status_label: "VERIFIED_ON_MAINNET_READ",
  };
}

/**
 * Dry quote only by default. Never sets dry:false unless allowFundedQuote=true
 * AND NIO_MAINNET_ALLOW_FUNDED_QUOTE=1.
 */
export async function productionDryQuote(request, opts = {}) {
  assertNetworkIsolation(MAINNET, { allowMainnet: true });
  const baseUrl = opts.baseUrl || DEFAULT_BASE;
  const token = opts.token || process.env.NIO_1CLICK_JWT;
  const allowFunded =
    opts.allowFundedQuote === true &&
    process.env.NIO_MAINNET_ALLOW_FUNDED_QUOTE === "1";

  const body = {
    dry: allowFunded ? false : true,
    swapType: request.swapType || "EXACT_INPUT",
    slippageTolerance: request.slippageTolerance ?? 100,
    originAsset: request.originAsset,
    depositType: request.depositType || "ORIGIN_CHAIN",
    destinationAsset: request.destinationAsset,
    amount: String(request.amount),
    refundTo: request.refundTo,
    refundType: request.refundType || "ORIGIN_CHAIN",
    recipient: request.recipient,
    recipientType: request.recipientType || "DESTINATION_CHAIN",
    deadline:
      request.deadline ||
      new Date(Date.now() + 15 * 60_000).toISOString(),
  };

  for (const k of [
    "originAsset",
    "destinationAsset",
    "amount",
    "refundTo",
    "recipient",
  ]) {
    if (!body[k]) {
      return { ok: false, reason: `missing_${k}` };
    }
  }

  if (body.dry === false && !allowFunded) {
    return { ok: false, reason: "funded_quote_blocked" };
  }

  const res = await fetch(`${baseUrl}/v0/quote`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 800) };
  }

  if (!res.ok) {
    return {
      ok: false,
      http_status: res.status,
      reason: res.status === 401 ? "jwt_required" : "quote_http_error",
      request: { ...body, dry: true },
      body: parsed,
      api: baseUrl,
      status_label: "NOT_YET_PROVEN",
    };
  }

  const quote = parsed.quote || parsed;
  return {
    ok: true,
    dry: body.dry,
    api: baseUrl,
    request: body,
    quote,
    deposit_address: body.dry ? null : quote.depositAddress || null,
    correlation_id: quote.correlationId || parsed.correlationId || null,
    amount_in: quote.amountIn || body.amount,
    amount_out: quote.amountOut || quote.minAmountOut || null,
    deadline: quote.deadline || body.deadline,
    status_label: body.dry
      ? "DRY_QUOTE_OBTAINED"
      : "FUNDED_QUOTE_OBTAINED_NO_DEPOSIT_YET",
    note: body.dry
      ? "Dry quote — no deposit address commitment; not a funded trade"
      : "Funded quote returned — deposit still requires separate broadcast approval",
  };
}

/** Official status model helper — poll by depositAddress when available. */
export async function getExecutionStatus(depositAddress, opts = {}) {
  assertNetworkIsolation(MAINNET, { allowMainnet: true });
  if (!depositAddress) {
    return { ok: false, reason: "deposit_address_required" };
  }
  const baseUrl = opts.baseUrl || DEFAULT_BASE;
  const token = opts.token || process.env.NIO_1CLICK_JWT;
  const url = new URL(`${baseUrl}/v0/status`);
  url.searchParams.set("depositAddress", depositAddress);
  const res = await fetch(url, { headers: authHeaders(token) });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    return {
      ok: false,
      http_status: res.status,
      reason: "status_http_error",
      body,
    };
  }
  const status = body.status || body.state || body;
  return {
    ok: true,
    deposit_address: depositAddress,
    status,
    normalized: normalizeIntentStatus(status),
    body,
  };
}

export function normalizeIntentStatus(status) {
  const s = String(
    typeof status === "string" ? status : status?.status || status?.state || ""
  ).toUpperCase();
  if (["SUCCESS", "SUCCEEDED", "COMPLETED"].includes(s)) return "SUCCESS";
  if (["FAILED", "FAILURE", "ERROR"].includes(s)) return "FAILED";
  if (["REFUNDED", "REFUND"].includes(s)) return "REFUNDED";
  if (["PENDING", "PROCESSING", "INCOMPLETE", "KNOWN_DEPOSIT_TX"].includes(s)) {
    return "PENDING";
  }
  return s || "UNKNOWN";
}
