/**
 * Official 1Click signed-quote verification (fail-closed).
 * Uses @defuse-protocol/one-click-sdk-typescript >= 0.1.26 — never disables TLS.
 *
 * SDK 0.1.26 signed subsets (mirrors internal buildSignedQuote / buildSignedQuoteRequest):
 * - dry: amounts only
 * - non-dry: amounts + depositAddress/depositMemo/deadline/timeWhenInactive/timeEstimate/fees
 * Request fields (recipient, refundTo, assets, …) are always in the signed request subset.
 */
import {
  hashQuote,
  quoteHash,
  verifyQuoteSignature,
} from "@defuse-protocol/one-click-sdk-typescript";
import nacl from "tweetnacl";
import bs58 from "bs58";

/** Pinned official 1Click manager key (SDK default). Production must use this. */
export const ONE_CLICK_MANAGER_PUB_KEY =
  "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";

export const SDK_SIGNATURE_COVERAGE = Object.freeze({
  sdk_version_required: ">=0.1.26",
  docs:
    "https://docs.near-intents.org/integration/distribution-channels/1click-api/verify-quote-signature",
  dry_quote_fields: [
    "amountIn",
    "amountInFormatted",
    "amountInUsd",
    "minAmountIn",
    "amountOut",
    "amountOutFormatted",
    "amountOutUsd",
    "minAmountOut",
  ],
  nondry_extra_fields: [
    "depositAddress",
    "depositMemo",
    "deadline",
    "timeWhenInactive",
    "timeEstimate",
    "refundFee",
    "withdrawFee",
  ],
  request_fields: [
    "dry",
    "swapType",
    "slippageTolerance",
    "originAsset",
    "depositType",
    "destinationAsset",
    "amount",
    "refundTo",
    "refundType",
    "recipient",
    "recipientType",
    "deadline",
  ],
  note:
    "0.1.24 hashed dry-like amounts only for all quotes (depositAddress NOT covered). 0.1.26 adds escrow/execution fields for non-dry only.",
});

const MAX_QUOTE_AGE_MS = 15 * 60_000;

/**
 * Mirror of SDK internal buildSignedQuoteRequest (not exported in 0.1.26).
 */
export function mirrorBuildSignedQuoteRequest(response) {
  const { quoteRequest } = response;
  return {
    dry: quoteRequest.dry,
    swapType: quoteRequest.swapType,
    slippageTolerance: quoteRequest.slippageTolerance,
    originAsset: quoteRequest.originAsset,
    depositType: quoteRequest.depositType,
    destinationAsset: quoteRequest.destinationAsset,
    amount: quoteRequest.amount,
    refundTo: quoteRequest.refundTo,
    refundType: quoteRequest.refundType,
    recipient: quoteRequest.recipient,
    recipientType: quoteRequest.recipientType,
    deadline: quoteRequest.deadline,
    quoteWaitingTimeMs: quoteRequest.quoteWaitingTimeMs
      ? quoteRequest.quoteWaitingTimeMs
      : undefined,
    referral: quoteRequest.referral ? quoteRequest.referral : undefined,
    virtualChainRecipient: quoteRequest.virtualChainRecipient
      ? quoteRequest.virtualChainRecipient
      : undefined,
    virtualChainRefundRecipient: quoteRequest.virtualChainRefundRecipient
      ? quoteRequest.virtualChainRefundRecipient
      : undefined,
    customRecipientMsg: quoteRequest.customRecipientMsg
      ? quoteRequest.customRecipientMsg
      : undefined,
    sessionId: undefined,
    connectedWallets: undefined,
    correlationId: undefined,
    appFees: undefined,
    partnerId: undefined,
    userAccountId: undefined,
    depositMode: undefined,
  };
}

/**
 * Mirror of SDK internal buildSignedQuote (not exported in 0.1.26).
 */
export function mirrorBuildSignedQuote(response) {
  const { quote } = response;
  const dry = response.quoteRequest.dry;
  if (dry) {
    return {
      amountIn: quote.amountIn,
      amountInFormatted: quote.amountInFormatted,
      amountInUsd: quote.amountInUsd,
      minAmountIn: quote.minAmountIn,
      amountOut: quote.amountOut,
      amountOutFormatted: quote.amountOutFormatted,
      amountOutUsd: quote.amountOutUsd,
      minAmountOut: quote.minAmountOut,
    };
  }
  return {
    amountIn: quote.amountIn,
    amountInFormatted: quote.amountInFormatted,
    amountInUsd: quote.amountInUsd,
    minAmountIn: quote.minAmountIn,
    amountOut: quote.amountOut,
    amountOutFormatted: quote.amountOutFormatted,
    amountOutUsd: quote.amountOutUsd,
    minAmountOut: quote.minAmountOut,
    depositAddress: quote.depositAddress || undefined,
    depositMemo: quote.depositMemo || undefined,
    deadline: quote.deadline || undefined,
    timeWhenInactive: quote.timeWhenInactive || undefined,
    timeEstimate: quote.timeEstimate || undefined,
    refundFee: quote.refundFee || undefined,
    withdrawFee: quote.withdrawFee || undefined,
  };
}

/**
 * Prefer authentic API OneClickQuoteResponse. Never rebuild signature from our request.
 */
export function toOneClickQuoteResponse(input) {
  if (!input || typeof input !== "object") return null;

  // Already authentic (or previously preserved)
  if (input.one_click_response?.quoteRequest && input.one_click_response?.quote) {
    return toOneClickQuoteResponse(input.one_click_response);
  }

  if (input.quoteRequest && input.quote) {
    return {
      quoteRequest: input.quoteRequest,
      quote: input.quote,
      signature: input.signature || null,
      timestamp: input.timestamp || null,
      correlationId:
        input.correlationId ||
        input.correlation_id ||
        input.quote?.correlationId ||
        null,
    };
  }

  // Legacy normalized productionDryQuote — only if signature/timestamp preserved
  if (input.request && input.quote && (input.signature || input.timestamp)) {
    return {
      quoteRequest: input.quoteRequest || input.request,
      quote: input.quote,
      signature: input.signature || null,
      timestamp: input.timestamp || null,
      correlationId:
        input.correlation_id ||
        input.correlationId ||
        input.quote?.correlationId ||
        null,
    };
  }

  return null;
}

export function quoteIsAuthenticatedSchedule(responseOrResult) {
  const req =
    responseOrResult?.quoteRequest ||
    responseOrResult?.request ||
    responseOrResult?.quote?.quoteRequest;
  return Boolean(
    responseOrResult?.authenticated === true ||
      req?.partnerId ||
      req?.appFees ||
      responseOrResult?.auth_mode === "jwt"
  );
}

export function bindQuoteRequestFields(response, agentRequest = {}) {
  const qr = response?.quoteRequest || {};
  const checks = [];
  const pairs = [
    ["originAsset", agentRequest.originAsset, qr.originAsset],
    ["destinationAsset", agentRequest.destinationAsset, qr.destinationAsset],
    ["amount", agentRequest.amount, qr.amount],
    ["depositType", agentRequest.depositType, qr.depositType],
    ["recipient", agentRequest.recipient, qr.recipient],
    ["refundTo", agentRequest.refundTo, qr.refundTo],
    ["dry", agentRequest.dry, qr.dry],
  ];
  for (const [name, want, got] of pairs) {
    if (want == null || want === "") {
      checks.push({ ok: true, check: name, skipped: true, value: got ?? null });
      continue;
    }
    const a = String(want).toLowerCase();
    const b = String(got ?? "").toLowerCase();
    if (a !== b) {
      return {
        ok: false,
        reason: `request_mismatch_${name}`,
        want: String(want),
        got: got == null ? null : String(got),
        checks,
      };
    }
    checks.push({ ok: true, check: name, value: String(got) });
  }
  return { ok: true, checks };
}

/**
 * Fail-closed official signature + freshness + request bind.
 * Production: pass no managerPublicKey override (uses pinned ONE_CLICK_MANAGER_PUB_KEY).
 * Tests only: may pass managerPublicKey for locally signed fixtures.
 */
export function verifySignedOneClickQuote(input, opts = {}) {
  const checks = [];
  const fail = (reason, extra = {}) => ({
    ok: false,
    verified: false,
    reason,
    checks,
    manager_key_mode: opts.managerPublicKey
      ? "test_override"
      : "pinned_official",
    ...extra,
  });

  const response = toOneClickQuoteResponse(input);
  if (!response) return fail("not_one_click_quote_response");

  if (!response.signature) return fail("unsigned_quote");
  if (!response.timestamp) return fail("missing_timestamp");
  if (!response.quoteRequest) return fail("missing_quote_request");
  if (!response.quote) return fail("missing_quote");

  const tsMs = Date.parse(response.timestamp);
  if (!Number.isFinite(tsMs)) return fail("invalid_timestamp");
  const maxAge = opts.maxAgeMs ?? MAX_QUOTE_AGE_MS;
  const now = opts.nowMs ?? Date.now();
  if (now - tsMs > maxAge) {
    return fail("stale_quote", {
      age_ms: now - tsMs,
      max_age_ms: maxAge,
      timestamp: response.timestamp,
    });
  }
  if (tsMs - now > 60_000) {
    return fail("timestamp_in_future", { timestamp: response.timestamp });
  }
  checks.push({
    ok: true,
    check: "timestamp_fresh",
    timestamp: response.timestamp,
  });

  if (opts.agentRequest) {
    const bind = bindQuoteRequestFields(response, opts.agentRequest);
    checks.push(...(bind.checks || []));
    if (!bind.ok) return fail(bind.reason, { bind });
  }

  const qDeposit = response.quote?.depositAddress;
  if (
    opts.agentRequest?.requestedDeposit &&
    qDeposit &&
    String(opts.agentRequest.requestedDeposit).toLowerCase() !==
      String(qDeposit).toLowerCase()
  ) {
    return fail("llm_deposit_address_rejected");
  }
  if (
    opts.forbidLlmDeposit === true &&
    opts.llmDepositAddress &&
    (!qDeposit ||
      String(opts.llmDepositAddress).toLowerCase() !==
        String(qDeposit).toLowerCase())
  ) {
    return fail("llm_deposit_address_rejected");
  }

  const managerKey = opts.managerPublicKey || ONE_CLICK_MANAGER_PUB_KEY;
  if (
    opts.requirePinnedOfficialKey === true &&
    opts.managerPublicKey &&
    opts.managerPublicKey !== ONE_CLICK_MANAGER_PUB_KEY
  ) {
    return fail("test_manager_key_forbidden_on_production_path");
  }

  let verified = false;
  try {
    verified = Boolean(verifyQuoteSignature(response, managerKey));
  } catch (e) {
    return fail("verify_threw", {
      detail: String(e.message || e).slice(0, 200),
    });
  }
  if (!verified) return fail("signature_invalid");

  let qh = null;
  try {
    qh = quoteHash(response);
  } catch (e) {
    return fail("quote_hash_failed", {
      detail: String(e.message || e).slice(0, 200),
    });
  }

  const dry = response.quoteRequest?.dry !== false;
  const escrowCovered =
    !dry && Boolean(mirrorBuildSignedQuote(response).depositAddress);
  checks.push({
    ok: true,
    check: "fee_schedule",
    authenticated: quoteIsAuthenticatedSchedule(response),
  });
  checks.push({
    ok: true,
    check: "sdk_escrow_coverage",
    dry,
    deposit_in_signed_subset: escrowCovered,
    note: dry
      ? "dry: depositAddress absent and not in signed subset"
      : escrowCovered
        ? "non-dry: depositAddress included in SDK 0.1.26 signed subset"
        : "non-dry missing depositAddress — escrow authenticity BLOCKED",
  });

  return {
    ok: true,
    verified: true,
    reason: null,
    quote_hash: qh,
    correlation_id: response.correlationId || null,
    deposit_address: response.quote?.depositAddress || null,
    timestamp: response.timestamp,
    signature: response.signature,
    authenticated_fee_schedule: quoteIsAuthenticatedSchedule(response),
    dry,
    escrow_in_signed_hash: escrowCovered,
    manager_key_mode: opts.managerPublicKey
      ? "test_override"
      : "pinned_official",
    checks,
    response,
  };
}

/**
 * Locally signed fixture for unit tests only — never use as production evidence.
 */
export function buildLocallySignedQuoteResponse({
  quoteRequest,
  quote,
  secretKey64,
  timestamp = new Date().toISOString(),
  correlationId = null,
}) {
  if (!secretKey64 || secretKey64.length !== 64) {
    throw new Error("secretKey64 (64-byte ed25519) required");
  }
  const responseShell = { quoteRequest, quote };
  const signedReq = mirrorBuildSignedQuoteRequest(responseShell);
  const signedQuote = mirrorBuildSignedQuote(responseShell);
  const qh = hashQuote(signedReq, signedQuote, timestamp);
  const msg = new TextEncoder().encode(qh);
  const sig = nacl.sign.detached(msg, secretKey64);
  const publicKey = `ed25519:${bs58.encode(
    nacl.sign.keyPair.fromSecretKey(secretKey64).publicKey
  )}`;
  return {
    quoteRequest,
    quote,
    timestamp,
    signature: `ed25519:${bs58.encode(sig)}`,
    correlationId: correlationId || quote.correlationId || `local-${Date.now()}`,
    quote_hash: qh,
    manager_public_key: publicKey,
    _fixture: true,
  };
}

export function mutateQuoteResponse(response, mutator) {
  const clone = structuredClone(response);
  mutator(clone);
  return clone;
}

export { verifyQuoteSignature, quoteHash, hashQuote };
