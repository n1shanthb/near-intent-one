/**
 * Official 1Click signed-quote verification (fail-closed).
 * Uses @defuse-protocol/one-click-sdk-typescript — never disables TLS.
 */
import {
  buildSignedQuote,
  buildSignedQuoteRequest,
  hashQuote,
  quoteHash,
  verifyQuoteSignature,
} from "@defuse-protocol/one-click-sdk-typescript";
import nacl from "tweetnacl";
import bs58 from "bs58";

export const ONE_CLICK_MANAGER_PUB_KEY =
  "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";

const MAX_QUOTE_AGE_MS = 15 * 60_000;

/**
 * Normalize productionDryQuote / raw API body into OneClickQuoteResponse shape.
 */
export function toOneClickQuoteResponse(input) {
  if (!input || typeof input !== "object") return null;
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
  // packages/mainnet/intents.mjs productionDryQuote shape
  if (input.request && input.quote) {
    return {
      quoteRequest: input.request,
      quote: input.quote,
      signature: input.signature || input.quote?.signature || null,
      timestamp: input.timestamp || input.quote?.timestamp || null,
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
  // Partner JWT / appFees / partnerId mark authenticated fee schedule surfaces.
  return Boolean(
    responseOrResult?.authenticated === true ||
      req?.partnerId ||
      req?.appFees ||
      responseOrResult?.auth_mode === "jwt"
  );
}

/**
 * Bind response.quoteRequest to the exact agent request (fail on mismatch).
 */
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
 */
export function verifySignedOneClickQuote(input, opts = {}) {
  const checks = [];
  const fail = (reason, extra = {}) => ({
    ok: false,
    verified: false,
    reason,
    checks,
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
  checks.push({ ok: true, check: "timestamp_fresh", timestamp: response.timestamp });

  if (opts.agentRequest) {
    const bind = bindQuoteRequestFields(response, opts.agentRequest);
    checks.push(...(bind.checks || []));
    if (!bind.ok) return fail(bind.reason, { bind });
  }

  // Reject LLM-supplied alternate deposit — only quote.depositAddress is authoritative.
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
  let verified = false;
  try {
    verified = Boolean(verifyQuoteSignature(response, managerKey));
  } catch (e) {
    return fail("verify_threw", { detail: String(e.message || e).slice(0, 200) });
  }
  if (!verified) return fail("signature_invalid");

  let qh = null;
  try {
    qh = quoteHash(response);
  } catch (e) {
    return fail("quote_hash_failed", { detail: String(e.message || e).slice(0, 200) });
  }

  const auth = quoteIsAuthenticatedSchedule(response);
  checks.push({
    ok: true,
    check: "fee_schedule",
    authenticated: auth,
    note: auth
      ? "authenticated/partner fee schedule fields present"
      : "unauthenticated public fee schedule",
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
    authenticated_fee_schedule: auth,
    dry: response.quoteRequest?.dry !== false,
    checks,
    response,
  };
}

/**
 * Build a locally signed OneClickQuoteResponse for unit tests (never mainnet).
 * Signs with an isolated ed25519 key — pass the matching public key to verify.
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
  const signedReq = buildSignedQuoteRequest(responseShell);
  const signedQuote = buildSignedQuote(responseShell);
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
  };
}

export function mutateQuoteResponse(response, mutator) {
  const clone = structuredClone(response);
  mutator(clone);
  return clone;
}

export {
  verifyQuoteSignature,
  quoteHash,
  hashQuote,
  buildSignedQuote,
  buildSignedQuoteRequest,
};
