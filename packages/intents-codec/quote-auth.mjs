/**
 * Quote attestation V2 + EIP-155 helpers (Gate F1+).
 * Must stay aligned with contracts/policy/src/evm_auth.rs.
 */
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/curves/abstract/utils";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  quoteHash as oneClickQuoteHash,
} from "@defuse-protocol/one-click-sdk-typescript";
import { verifySignedOneClickQuote } from "./oneClickVerify.mjs";

export function attestationMessageV2({
  depositAddress,
  amountIn,
  assetIn,
  assetOut,
  minAmountOut,
  quoteDeadlineNs,
  tokenContract,
  chainId,
  recipient,
  refundTo,
  correlationId,
  quoteHash,
  maxGasPrice,
  gasLimit,
}) {
  return Buffer.from(
    `QUOTE_AUTH_V2\ndeposit=${depositAddress.toLowerCase()}\namount_in=${amountIn}\nasset_in=${assetIn}\nasset_out=${assetOut}\nmin_out=${minAmountOut}\ndeadline_ns=${quoteDeadlineNs}\ntoken=${tokenContract.toLowerCase()}\nchain_id=${chainId}\nrecipient=${recipient.toLowerCase()}\nrefund_to=${refundTo.toLowerCase()}\ncorrelation_id=${correlationId}\nquote_hash=${quoteHash}\nmax_gas_price=${maxGasPrice}\ngas_limit=${gasLimit}\n`,
    "utf8"
  );
}

/** @deprecated Gate E V1 — kept for evidence continuity only */
export function attestationMessage(args) {
  return Buffer.from(
    `QUOTE_AUTH_V1\ndeposit=${args.depositAddress.toLowerCase()}\namount_in=${args.amountIn}\nasset_in=${args.assetIn}\nasset_out=${args.assetOut}\nmin_out=${args.minAmountOut}\ndeadline_ns=${args.quoteDeadlineNs}\ntoken=${args.tokenContract.toLowerCase()}\nchain_id=${args.chainId}\n`,
    "utf8"
  );
}

export function signAttestation(messageBytes, secretKey64) {
  const sig = nacl.sign.detached(messageBytes, secretKey64);
  return `ed25519:${bs58.encode(sig)}`;
}

export function publicKeyEd25519(secretKey64) {
  const kp = nacl.sign.keyPair.fromSecretKey(secretKey64);
  return `ed25519:${bs58.encode(kp.publicKey)}`;
}

export function attestationId(messageBytes) {
  return bytesToHex(sha256(messageBytes));
}

/**
 * Independent attestor: validates Tidepool quote against agent request BEFORE signing.
 * Refuses arbitrary destinations that are not the quote's depositAddress.
 */
/**
 * Trusted app-config modes (never taken from quoteResponse fields):
 * - productionMode / mainnetFundedPath: pinned official 1Click key, no unverified escape
 * - allowTestFixtureMode: local unit tests only (env NIO_ALLOW_TEST_FIXTURE=1 OR explicit true)
 */
export function attestTidepoolQuote({
  quoteResponse,
  agentRequest,
  tokenContract,
  chainId,
  maxGasPrice,
  gasLimit,
  secretKey64,
  tidepoolManagerPubKey = null,
  /**
   * Legacy Gate F/testnet only. Forbidden whenever productionMode/mainnetFundedPath.
   */
  allowUnverifiedOneClick = false,
  maxAgeMs,
  nowMs,
  /** Production mainnet funded path — forces pinned official key + bans unverified escape */
  mainnetFundedPath = false,
  /** Alias — same as mainnetFundedPath when true */
  productionMode = false,
  /**
   * Trusted config only: allow test manager-key overrides for synthetic fixtures.
   * NEVER derived from quoteResponse._fixture (untrusted).
   */
  allowTestFixtureMode = false,
  /** Live policy limits for economic checks (mainnet production). */
  policyLimits = null,
  allowedDestinations = null,
  allowedAssets = null,
  allowedChains = null,
}) {
  const checks = [];
  const fail = (reason) => {
    checks.push({ ok: false, reason });
    return { ok: false, checks, attestation: null, signature: null, publicKey: null };
  };

  const envMainnet =
    process.env.NIO_NETWORK === "mainnet" ||
    process.env.NEAR_NETWORK === "mainnet";
  const fundedShape = quoteResponse?.quoteRequest?.dry === false;
  // Trusted config only — ignore any quoteResponse._fixture flag (attacker-controlled).
  const testFixtureTrusted =
    allowTestFixtureMode === true ||
    process.env.NIO_ALLOW_TEST_FIXTURE === "1";
  const production =
    productionMode === true ||
    mainnetFundedPath === true ||
    (envMainnet && fundedShape && !testFixtureTrusted);

  if (production && allowUnverifiedOneClick) {
    return fail("allowUnverifiedOneClick_forbidden_on_production_path");
  }
  if (production && tidepoolManagerPubKey) {
    return fail("alternate_manager_key_forbidden_on_production_path");
  }
  if (production && !fundedShape) {
    return fail("production_requires_non_dry_signed_quote");
  }

  if (!quoteResponse?.quote?.depositAddress) {
    return fail("missing depositAddress");
  }
  if (!quoteResponse.correlationId) return fail("missing correlationId");
  if (!quoteResponse.signature) return fail("missing quote signature field");

  const q = quoteResponse.quote;
  const qr = quoteResponse.quoteRequest || {};

  // Structural bind to agent request
  const expect = [
    ["originAsset", agentRequest.originAsset, qr.originAsset],
    ["destinationAsset", agentRequest.destinationAsset, qr.destinationAsset],
    ["amount", agentRequest.amount, qr.amount || q.amountIn],
    ["depositType", agentRequest.depositType, qr.depositType],
    ["recipient", agentRequest.recipient?.toLowerCase(), qr.recipient?.toLowerCase()],
    ["refundTo", agentRequest.refundTo?.toLowerCase(), qr.refundTo?.toLowerCase()],
  ];
  for (const [name, want, got] of expect) {
    if (want && got && String(want) !== String(got)) {
      return fail(`quote field mismatch ${name}: want=${want} got=${got}`);
    }
    checks.push({ ok: true, check: name, value: got });
  }

  // Critical: deposit must come from quote, never agent-supplied alternate
  if (
    agentRequest.requestedDeposit &&
    agentRequest.requestedDeposit.toLowerCase() !== q.depositAddress.toLowerCase()
  ) {
    return fail("agent requestedDeposit != quote.depositAddress — refusing to attest");
  }
  checks.push({
    ok: true,
    check: "deposit_from_quote_only",
    depositAddress: q.depositAddress,
  });

  // Official 1Click signature MUST verify before we generate our attestation.
  // Production: pinned official manager key only (no test override).
  const oneClick = verifySignedOneClickQuote(quoteResponse, {
    agentRequest,
    managerPublicKey: production
      ? undefined
      : tidepoolManagerPubKey || undefined,
    requirePinnedOfficialKey: production,
    maxAgeMs,
    nowMs,
    forbidLlmDeposit: true,
    llmDepositAddress: agentRequest?.requestedDeposit || null,
  });
  checks.push({
    ok: oneClick.ok,
    check: "one_click_signature_verify",
    verified: oneClick.verified,
    reason: oneClick.reason || null,
    quote_hash: oneClick.quote_hash || null,
    escrow_in_signed_hash: oneClick.escrow_in_signed_hash === true,
    manager_key_mode: oneClick.manager_key_mode || null,
  });
  if (!oneClick.ok && !(allowUnverifiedOneClick && !production)) {
    return fail(`one_click_verify_failed:${oneClick.reason}`);
  }
  if (!oneClick.ok && allowUnverifiedOneClick && !production) {
    checks.push({
      ok: true,
      check: "allow_unverified_legacy_escape",
      note: "explicit allowUnverifiedOneClick — LEGACY TESTNET ONLY; forbidden on production",
    });
  }
  // Escrow authenticity: attestor signature alone is NOT proof of 1Click escrow origin
  // unless the official signed subset covers depositAddress (non-dry + SDK >=0.1.26).
  if ((fundedShape || production) && oneClick.ok && !oneClick.escrow_in_signed_hash) {
    return fail("escrow_not_in_official_signed_hash");
  }

  const qh = oneClick.quote_hash || oneClickQuoteHash(quoteResponse);
  const deadlineIso = q.deadline || agentRequest.deadline;
  if (!deadlineIso || !Number.isFinite(Date.parse(deadlineIso))) {
    return fail("missing_or_invalid_quote_deadline");
  }
  const quoteDeadlineNs = String(BigInt(Date.parse(deadlineIso)) * 1_000_000n);
  const nowNs = BigInt(nowMs ?? Date.now()) * 1_000_000n;
  if (BigInt(quoteDeadlineNs) <= nowNs) {
    return fail("quote_deadline_expired");
  }

  // Custody / chain / asset allowlists when provided (mainnet production)
  const recipient = String(qr.recipient || agentRequest.recipient || "").toLowerCase();
  const refundTo = String(qr.refundTo || agentRequest.refundTo || "").toLowerCase();
  if (Array.isArray(allowedDestinations) && allowedDestinations.length) {
    const allow = new Set(allowedDestinations.map((d) => String(d).toLowerCase()));
    if (!allow.has(recipient)) return fail("recipient_not_in_allowed_destinations");
    if (!allow.has(refundTo)) return fail("refund_to_not_in_allowed_destinations");
  }
  if (Array.isArray(allowedAssets) && allowedAssets.length) {
    const allowA = new Set(allowedAssets.map(String));
    if (!allowA.has(agentRequest.originAsset)) return fail("asset_in_not_allowed");
    if (!allowA.has(agentRequest.destinationAsset)) return fail("asset_out_not_allowed");
  }
  if (Array.isArray(allowedChains) && allowedChains.length) {
    const cid = String(chainId);
    const eip = `eip155:${cid}`;
    const okChain = allowedChains.some(
      (c) => String(c) === cid || String(c) === eip || String(c) === `eip155:${cid}`
    );
    if (!okChain) return fail("chain_id_not_allowed");
  }

  // Economic checks vs live policy limits (fail closed when limits supplied)
  if (policyLimits) {
    const amountIn = BigInt(q.amountIn);
    const maxTrade = BigInt(policyLimits.max_trade_value ?? policyLimits.maxTradeValue ?? 0);
    if (maxTrade > 0n && amountIn > maxTrade) return fail("exceeds_max_trade_value");
    const slipBps = Number(
      policyLimits.max_slippage_bps ?? policyLimits.maxSlippageBps ?? 100
    );
    const floor = (amountIn * (10000n - BigInt(slipBps))) / 10000n;
    const minOut = BigInt(q.minAmountOut);
    if (!(minOut >= floor || minOut >= amountIn)) {
      return fail(`min_out_below_policy_floor:${minOut}<${floor}`);
    }
    const gasCost = BigInt(maxGasPrice) * BigInt(gasLimit);
    const gasBudget = BigInt(
      policyLimits.max_gas_budget ?? policyLimits.maxGasBudget ?? 0
    );
    if (gasBudget > 0n && gasCost > gasBudget) return fail("exceeds_max_gas_budget");
    checks.push({
      ok: true,
      check: "policy_economics",
      floor: String(floor),
      min_out: String(minOut),
      gas_cost: String(gasCost),
    });
  }

  const attestation = {
    deposit_address: q.depositAddress.toLowerCase(),
    amount_in: q.amountIn,
    asset_in: agentRequest.originAsset,
    asset_out: agentRequest.destinationAsset,
    min_amount_out: q.minAmountOut,
    quote_deadline_ns: quoteDeadlineNs,
    token_contract: tokenContract.toLowerCase(),
    chain_id: String(chainId),
    recipient: (qr.recipient || agentRequest.recipient).toLowerCase(),
    refund_to: (qr.refundTo || agentRequest.refundTo).toLowerCase(),
    correlation_id: quoteResponse.correlationId,
    quote_hash: qh,
    max_gas_price: String(maxGasPrice),
    gas_limit: String(gasLimit),
  };

  const msg = attestationMessageV2({
    depositAddress: attestation.deposit_address,
    amountIn: attestation.amount_in,
    assetIn: attestation.asset_in,
    assetOut: attestation.asset_out,
    minAmountOut: attestation.min_amount_out,
    quoteDeadlineNs: attestation.quote_deadline_ns,
    tokenContract: attestation.token_contract,
    chainId: attestation.chain_id,
    recipient: attestation.recipient,
    refundTo: attestation.refund_to,
    correlationId: attestation.correlation_id,
    quoteHash: attestation.quote_hash,
    maxGasPrice: attestation.max_gas_price,
    gasLimit: attestation.gas_limit,
  });
  const signature = signAttestation(msg, secretKey64);
  const publicKey = publicKeyEd25519(secretKey64);

  return {
    ok: true,
    checks,
    oneClickVerify: oneClick,
    tidepoolVerify: {
      status: oneClick.ok ? "PASS" : "BLOCKED",
      verified: oneClick.verified,
      reason: oneClick.reason || null,
    },
    attestation,
    signature,
    publicKey,
    message_utf8: msg.toString("utf8"),
    attestation_id: attestationId(msg),
    trust_model: oneClick.ok
      ? "one_click_verified_then_trusted_attestor"
      : "trusted_attestor_not_tidepool_maker",
  };
}

function bigIntToMinimalBytes(n) {
  if (n === 0n) return Buffer.alloc(0);
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return Buffer.from(hex, "hex");
}

export function rlpEncode(item) {
  if (item instanceof Uint8Array || Buffer.isBuffer(item)) {
    const buf = Buffer.from(item);
    if (buf.length === 1 && buf[0] < 0x80) return buf;
    if (buf.length <= 55) {
      return Buffer.concat([Buffer.from([0x80 + buf.length]), buf]);
    }
    const lenBuf = bigIntToMinimalBytes(BigInt(buf.length));
    return Buffer.concat([Buffer.from([0xb7 + lenBuf.length]), lenBuf, buf]);
  }
  if (Array.isArray(item)) {
    const encoded = Buffer.concat(item.map(rlpEncode));
    if (encoded.length <= 55) {
      return Buffer.concat([Buffer.from([0xc0 + encoded.length]), encoded]);
    }
    const lenBuf = bigIntToMinimalBytes(BigInt(encoded.length));
    return Buffer.concat([Buffer.from([0xf7 + lenBuf.length]), lenBuf, encoded]);
  }
  throw new Error("rlp: unsupported");
}

export function encodeQuantity(n) {
  return bigIntToMinimalBytes(typeof n === "bigint" ? n : BigInt(n));
}

export function erc20TransferData(to, amount) {
  const sel = Buffer.from("a9059cbb", "hex");
  const addr = Buffer.from(to.replace(/^0x/, "").toLowerCase().padStart(64, "0"), "hex");
  const amt = Buffer.from(BigInt(amount).toString(16).padStart(64, "0"), "hex");
  return Buffer.concat([sel, addr, amt]);
}

export function eip155UnsignedDigest({
  nonce,
  gasPrice,
  gasLimit,
  to,
  value = 0n,
  data,
  chainId,
}) {
  const payload = rlpEncode([
    encodeQuantity(nonce),
    encodeQuantity(gasPrice),
    encodeQuantity(gasLimit),
    Buffer.from(to.replace(/^0x/, ""), "hex"),
    encodeQuantity(value),
    data,
    encodeQuantity(chainId),
    Buffer.alloc(0),
    Buffer.alloc(0),
  ]);
  return keccak_256(payload);
}

export function digestHex(digest) {
  return bytesToHex(digest);
}

export function serializeSignedTx({
  nonce,
  gasPrice,
  gasLimit,
  to,
  value = 0n,
  data = Buffer.alloc(0),
  chainId,
  r,
  s,
  recoveryId,
}) {
  const v = BigInt(chainId) * 2n + 35n + BigInt(recoveryId);
  const raw = rlpEncode([
    encodeQuantity(nonce),
    encodeQuantity(gasPrice),
    encodeQuantity(gasLimit),
    Buffer.from(to.replace(/^0x/, ""), "hex"),
    encodeQuantity(value),
    data,
    encodeQuantity(v),
    Buffer.from(r),
    Buffer.from(s),
  ]);
  return "0x" + Buffer.from(raw).toString("hex");
}
