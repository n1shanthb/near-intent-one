/**
 * Production 1Click route adapter — dry quotes + binding/validation.
 * Never broadcasts deposits or sets dry:false without explicit funded gates.
 */
import { createHash } from "node:crypto";
import { MAINNET } from "../networks/profiles.mjs";
import {
  fetchProductionTokens,
  productionDryQuote,
  getExecutionStatus,
  normalizeIntentStatus,
} from "./intents.mjs";
import { ROUTE_STATUS } from "../execution/router.mjs";

export const PRODUCTION_ASSETS = Object.freeze({
  arbUsdc: MAINNET.intents.exampleOriginAsset,
  wrapNear: MAINNET.intents.exampleDestAsset,
  ethUsdc: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
  baseUsdc: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
});

/** Discover supported origin/dest pairs from live registry (read-only). */
export async function discoverSupportedRoutes(opts = {}) {
  const tokens = await fetchProductionTokens(opts);
  if (!tokens.ok) {
    return {
      ok: false,
      status: ROUTE_STATUS.BLOCKED,
      reason: tokens.reason || "tokens_unavailable",
      detail: tokens,
    };
  }
  const list = Array.isArray(tokens.tokens) ? tokens.tokens : [];
  const byId = new Map(list.map((t) => [t.assetId || t.asset_id, t]));
  const required = [
    PRODUCTION_ASSETS.arbUsdc,
    PRODUCTION_ASSETS.wrapNear,
    PRODUCTION_ASSETS.ethUsdc,
  ];
  const present = {};
  for (const id of required) {
    present[id] = byId.has(id);
  }
  return {
    ok: true,
    status_label: "VERIFIED_ON_MAINNET_READ",
    count: list.length,
    present,
    sample_route: {
      originAsset: PRODUCTION_ASSETS.arbUsdc,
      destinationAsset: PRODUCTION_ASSETS.wrapNear,
      note: "Canonical dry-quote candidate; requires JWT for /v0/quote",
    },
  };
}

export function validateQuoteRequest(req) {
  const fails = [];
  if (!req?.originAsset) fails.push("missing_originAsset");
  if (!req?.destinationAsset) fails.push("missing_destinationAsset");
  if (!req?.amount || BigInt(String(req.amount)) <= 0n) fails.push("bad_amount");
  if (!req?.recipient) fails.push("missing_recipient");
  if (!req?.refundTo) fails.push("missing_refundTo");
  if (req.originAsset === req.destinationAsset) fails.push("same_asset");
  if (fails.length) return { ok: false, reasons: fails };
  return { ok: true };
}

export function validateRecipientRefund(req, { allowedRecipients = [], allowedRefunds = [] } = {}) {
  const fails = [];
  const rec = String(req.recipient || "").toLowerCase();
  const ref = String(req.refundTo || "").toLowerCase();
  if (!rec) fails.push("recipient_empty");
  if (!ref) fails.push("refund_empty");
  if (allowedRecipients.length && !allowedRecipients.map((x) => x.toLowerCase()).includes(rec)) {
    fails.push("recipient_not_allowlisted");
  }
  if (allowedRefunds.length && !allowedRefunds.map((x) => x.toLowerCase()).includes(ref)) {
    fails.push("refund_not_allowlisted");
  }
  if (fails.length) return { ok: false, reasons: fails };
  return { ok: true, recipient: rec, refundTo: ref };
}

export function quoteExpiryMs(quote, requestDeadline) {
  const iso =
    quote?.deadline ||
    quote?.quote?.deadline ||
    quote?.request?.deadline ||
    requestDeadline;
  if (!iso) return { ok: false, reason: "missing_deadline" };
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return { ok: false, reason: "bad_deadline" };
  const remaining = ms - Date.now();
  return {
    ok: remaining > 0,
    deadline: iso,
    remaining_ms: remaining,
    expired: remaining <= 0,
  };
}

/** Bind dry/funded quote fields back to the agent request (pre-attestation). */
export function bindQuoteToRequest(quoteResult, request) {
  const q = quoteResult?.quote?.quote || quoteResult?.quote || quoteResult;
  const qr = quoteResult?.quote?.quoteRequest || quoteResult?.request || {};
  const fails = [];
  const checks = [
    ["originAsset", request.originAsset, qr.originAsset || request.originAsset],
    ["destinationAsset", request.destinationAsset, qr.destinationAsset || request.destinationAsset],
    ["amount", String(request.amount), String(qr.amount || q.amountIn || request.amount)],
    ["recipient", String(request.recipient).toLowerCase(), String(qr.recipient || request.recipient).toLowerCase()],
    ["refundTo", String(request.refundTo).toLowerCase(), String(qr.refundTo || request.refundTo).toLowerCase()],
  ];
  for (const [name, want, got] of checks) {
    if (String(want) !== String(got)) fails.push(`${name}_mismatch`);
  }
  const amountOut = q.amountOut || q.minAmountOut || quoteResult?.amount_out;
  if (!amountOut) fails.push("missing_amount_out");
  // Dry quotes often omit nested deadline; use top-level result / request deadline.
  const expiry = quoteExpiryMs(
    {
      deadline: quoteResult?.deadline || q.deadline || qr.deadline,
      request: quoteResult?.request,
    },
    request.deadline || quoteResult?.request?.deadline
  );
  if (!expiry.ok) fails.push(expiry.reason || "quote_expired");

  const binding_digest = createHash("sha256")
    .update(
      JSON.stringify({
        originAsset: request.originAsset,
        destinationAsset: request.destinationAsset,
        amount: String(request.amount),
        amountOut: String(amountOut || ""),
        recipient: String(request.recipient).toLowerCase(),
        refundTo: String(request.refundTo).toLowerCase(),
        correlationId: quoteResult.correlation_id || q.correlationId || null,
        deadline: expiry.deadline || null,
        dry: quoteResult.dry !== false,
      })
    )
    .digest("hex");

  if (fails.length) {
    return { ok: false, reasons: fails, binding_digest, may_attest: false };
  }
  return {
    ok: true,
    binding_digest,
    may_attest: true,
    amount_out: String(amountOut),
    deadline: expiry.deadline,
    remaining_ms: expiry.remaining_ms,
    deposit_address: quoteResult.deposit_address || q.depositAddress || null,
    note: quoteResult.dry
      ? "Dry quote bound — deposit address absent until funded quote"
      : "Funded quote bound — deposit still requires separate broadcast approval",
  };
}

export function depositInstructions(bound) {
  if (!bound?.deposit_address) {
    return {
      ok: false,
      reason: "no_deposit_address",
      note: "Dry quotes do not allocate deposit addresses; funded quote gated OFF",
    };
  }
  return {
    ok: true,
    deposit_address: bound.deposit_address,
    steps: [
      "Verify deposit_address matches bound quote exactly",
      "Authorize ERC-20 transfer via propose_quoted_evm_transfer only",
      "Do not broadcast until NIO_MAINNET_ALLOW_BROADCAST=1 + operator approval",
    ],
  };
}

export async function pollUntilTerminal(depositAddress, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 3;
  const delayMs = opts.delayMs ?? 0;
  const history = [];
  for (let i = 0; i < maxAttempts; i++) {
    const st = await getExecutionStatus(depositAddress, opts);
    const normalized = st.ok ? st.normalized : "ERROR";
    history.push({ attempt: i + 1, normalized, raw: st });
    if (["SUCCESS", "FAILED", "REFUNDED"].includes(normalized)) {
      return { ok: true, terminal: normalized, history };
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { ok: false, terminal: "PENDING", history, reason: "not_terminal_within_budget" };
}

export function reconcileSettlement({ status, expectedRecipient, expectedMinOut }) {
  const normalized = normalizeIntentStatus(status);
  if (normalized === "REFUNDED") {
    return { ok: true, outcome: "REFUNDED", note: "Funds returned — treat as terminal failure for exposure release" };
  }
  if (normalized === "FAILED") {
    return { ok: true, outcome: "FAILED", note: "Check refund path; do not mark Success" };
  }
  if (normalized !== "SUCCESS") {
    return { ok: false, outcome: normalized, note: "Not terminal" };
  }
  // Success path — structural checks only; amount proof is off-chain evidence.
  return {
    ok: true,
    outcome: "SUCCESS",
    expectedRecipient: expectedRecipient || null,
    expectedMinOut: expectedMinOut || null,
    note: "Status SUCCESS — attach chain receipt before releasing exposure",
  };
}

/**
 * End-to-end dry route attempt for the production adapter.
 * Returns real quote evidence or the exact blocker.
 */
export async function attemptProductionDryRoute(request, opts = {}) {
  const v = validateQuoteRequest(request);
  if (!v.ok) {
    return { ok: false, status: ROUTE_STATUS.BLOCKED, reason: "invalid_request", detail: v };
  }
  const dest = validateRecipientRefund(request, opts);
  if (!dest.ok) {
    return { ok: false, status: ROUTE_STATUS.BLOCKED, reason: "destination_rejected", detail: dest };
  }

  const discovery = await discoverSupportedRoutes(opts);
  if (!discovery.ok) {
    return {
      ok: false,
      status: ROUTE_STATUS.BLOCKED,
      reason: discovery.reason,
      blocker: "token_registry",
      detail: discovery,
    };
  }

  const quote = await productionDryQuote(request, opts);
  if (!quote.ok) {
    const apiMsg =
      quote.body?.message ||
      quote.body?.error ||
      (typeof quote.body?.raw === "string" ? quote.body.raw.slice(0, 200) : null);
    const jwtMissing =
      quote.http_status === 401 ||
      quote.reason === "jwt_required" ||
      (!opts.token &&
        !process.env.NIO_1CLICK_JWT &&
        quote.http_status !== 400 &&
        !apiMsg);
    let blocker = quote.reason;
    if (apiMsg) blocker = String(apiMsg);
    else if (jwtMissing) blocker = "NIO_1CLICK_JWT unset — partner JWT required for /v0/quote";
    else if (quote.http_status === 403) blocker = "1Click WAF/auth rejected quote POST from this host";
    return {
      ok: false,
      status: ROUTE_STATUS.BLOCKED,
      reason: quote.reason,
      blocker,
      http_status: quote.http_status || null,
      detail: quote,
      discovery,
    };
  }

  const bound = bindQuoteToRequest(quote, request);
  if (!bound.ok) {
    return {
      ok: false,
      status: ROUTE_STATUS.BLOCKED,
      reason: "quote_binding_failed",
      detail: bound,
      quote,
    };
  }

  return {
    ok: true,
    status: ROUTE_STATUS.QUOTED,
    dry: true,
    quote,
    bound,
    deposit: depositInstructions(bound),
    funded_execution: "DISABLED",
    status_label: "DRY_QUOTE_OBTAINED",
  };
}

/** Router-facing adapter. */
export function createProductionNearIntentsAdapter(opts = {}) {
  return {
    id: "near_intents_1click",
    async quote(req) {
      const out = await attemptProductionDryRoute(req, opts);
      if (!out.ok) {
        return {
          ok: false,
          status: out.status || ROUTE_STATUS.NO_SAFE_LIQUIDITY,
          reason: out.blocker || out.reason,
          detail: out,
        };
      }
      return {
        ok: true,
        status: ROUTE_STATUS.QUOTED,
        amount_out: out.bound.amount_out,
        deadline: out.bound.deadline,
        binding_digest: out.bound.binding_digest,
        dry: true,
        note: "Production dry quote — not a deposit / not funded",
      };
    },
  };
}
