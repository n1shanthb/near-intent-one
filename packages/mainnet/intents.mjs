/**
 * Production NEAR Intents via official 1Click API + SDK surface.
 * Tidepool/testnet contracts are NEVER used here.
 * Funded quotes (dry:false) require separate authorization.
 */
import {
  OpenAPI,
  OneClickService,
} from "@defuse-protocol/one-click-sdk-typescript";
import { MAINNET, assertNetworkIsolation } from "../networks/profiles.mjs";

const DEFAULT_BASE = MAINNET.intents.apiBase;

/** Configure official SDK client (Bearer when JWT present). */
export function configureOneClickSdk({
  baseUrl = DEFAULT_BASE,
  token = process.env.NIO_1CLICK_JWT,
} = {}) {
  OpenAPI.BASE = baseUrl;
  OpenAPI.TOKEN = token || undefined;
  OpenAPI.HEADERS = token
    ? { authorization: `Bearer ${token}`, "x-api-key": token }
    : undefined;
  return { baseUrl, authenticated: Boolean(token) };
}

/**
 * Prefer fetch helpers for deterministic dry:true enforcement; SDK wraps status/tokens.
 */
export async function sdkGetTokens(opts = {}) {
  configureOneClickSdk(opts);
  try {
    const tokens = await OneClickService.getTokens();
    const list = Array.isArray(tokens) ? tokens : tokens?.tokens || [];
    return { ok: true, via: "sdk", count: list.length, tokens: list };
  } catch (e) {
    return {
      ok: false,
      via: "sdk",
      reason: "sdk_getTokens_failed",
      detail: String(e?.message || e).slice(0, 300),
    };
  }
}

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
  let res;
  let text;
  try {
    res = await fetch(`${baseUrl}/v0/tokens`, {
      headers: authHeaders(token),
    });
    text = await res.text();
  } catch (e) {
    const msg = String(e?.cause?.message || e?.message || e);
    return {
      ok: false,
      reason: /certificate|TLS|SSL|UNABLE_TO_VERIFY/i.test(msg)
        ? "tokens_tls_error"
        : "tokens_network_error",
      detail: msg.slice(0, 300),
      api: baseUrl,
    };
  }
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

  let res;
  let text;
  try {
    res = await fetch(`${baseUrl}/v0/quote`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(body),
    });
    text = await res.text();
  } catch (e) {
    const msg = String(e?.cause?.message || e?.message || e);
    return {
      ok: false,
      reason: /certificate|TLS|SSL|UNABLE_TO_VERIFY/i.test(msg)
        ? "quote_tls_error"
        : "quote_network_error",
      detail: msg.slice(0, 300),
      request: { ...body, dry: true },
      api: baseUrl,
      status_label: "NOT_YET_PROVEN",
    };
  }
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

/**
 * Which signing primitive is required for a 1Click ORIGIN_CHAIN deposit route.
 * Does not authorize signing — classification only.
 */
export function requiredSigningPrimitive({
  originNetwork,
  depositType = "ORIGIN_CHAIN",
} = {}) {
  const chain = String(originNetwork || "").toLowerCase();
  if (depositType === "INTENTS") {
    return {
      primitive: "NEAR_INTENTS_SIGNED_PAYLOAD",
      custody_model: "intents_account",
      note: "INTENTS deposit uses signed intent payload — not enabled for NIO funded canary; custody model unchanged",
      may_use: false,
    };
  }
  if (chain === "near") {
    return {
      primitive: "NEAR_NATIVE_FT_TRANSFER_OR_STORAGE",
      custody_model: "policy_near_account",
      note: "NEP-141 deposit is NOT authorized by EVM Chain Signatures MPC path",
      may_use: false,
      policy_path: "near_ft_separate_from_quoted_evm",
    };
  }
  if (["ethereum", "arbitrum", "base", "eth", "arb"].includes(chain)) {
    return {
      primitive: "EVM_ERC20_TRANSFER_TO_DEPOSIT",
      custody_model: "policy_mpc_evm",
      note: "Use propose_quoted_evm_transfer only — transfer(deposit, amount); no arbitrary calldata",
      may_use: true,
      policy_path: "quoted_evm_transfer",
    };
  }
  return {
    primitive: "UNKNOWN",
    custody_model: "unknown",
    note: "Unsupported origin for current policy surfaces",
    may_use: false,
  };
}

/**
 * Build deposit tx intent for an ORIGIN_CHAIN funded quote (gated — never broadcasts).
 */
export function constructOriginChainDeposit({
  bound,
  originNetwork,
  tokenContract,
  amount,
  chainId,
}) {
  if (process.env.NIO_MAINNET_ALLOW_FUNDED_QUOTE !== "1") {
    return {
      ok: false,
      reason: "funded_quote_gate_off",
      note: "Deposit construction refused while funded quotes are disabled",
    };
  }
  if (!bound?.deposit_address) {
    return { ok: false, reason: "missing_deposit_address" };
  }
  const signing = requiredSigningPrimitive({
    originNetwork,
    depositType: "ORIGIN_CHAIN",
  });
  if (!signing.may_use) {
    return { ok: false, reason: "signing_primitive_unavailable", signing };
  }
  return {
    ok: true,
    dry_broadcast: true,
    may_broadcast: false,
    deposit_address: bound.deposit_address,
    amount: String(amount),
    token_contract: tokenContract,
    chain_id: chainId,
    signing,
    tx_shape: {
      kind: "erc20_transfer",
      to: tokenContract,
      spender_or_token: tokenContract,
      transfer_to: bound.deposit_address,
      value: "0",
      decoded: {
        selector: "transfer(address,uint256)",
        recipient: bound.deposit_address,
        amount: String(amount),
      },
    },
    note: "Construction only — NIO_MAINNET_ALLOW_BROADCAST + canary approval required to send",
  };
}

/** SDK status poll wrapper. */
export async function sdkGetExecutionStatus(depositAddress, opts = {}) {
  if (!depositAddress) return { ok: false, reason: "deposit_address_required" };
  configureOneClickSdk(opts);
  try {
    const body = await OneClickService.getExecutionStatus(depositAddress);
    const status = body?.status || body?.state || body;
    return {
      ok: true,
      via: "sdk",
      deposit_address: depositAddress,
      status,
      normalized: normalizeIntentStatus(status),
      body,
    };
  } catch (e) {
    return {
      ok: false,
      via: "sdk",
      reason: "sdk_status_failed",
      detail: String(e?.message || e).slice(0, 300),
    };
  }
}
