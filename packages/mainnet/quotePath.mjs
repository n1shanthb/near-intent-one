/**
 * J5 — Quote → attestation → ERC-20 path (local / simulation only).
 * Never broadcasts. Never registers trusted signer on mainnet.
 */
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  attestTidepoolQuote,
  attestationMessageV2,
  publicKeyEd25519,
  attestationId,
  erc20TransferData,
  eip155UnsignedDigest,
  digestHex,
} from "../intents-codec/quote-auth.mjs";
import {
  verifySignedOneClickQuote,
  buildLocallySignedQuoteResponse,
} from "../intents-codec/oneClickVerify.mjs";
import { analyzeDecimalsRisk } from "./decimalsRisk.mjs";

export const MAINNET_EPOCH = 2;
export const MPC_EVM = "0xee82d6327a929cc3feb1dd10b71b3553a19c7cd4";

export const ASSETS = Object.freeze({
  eth_usdc: {
    asset_id: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
    token_contract: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    decimals: 6,
    chain_id: 1,
    symbol: "USDC",
  },
  wrap_near: {
    asset_id: "nep141:wrap.near",
    token_contract: "wrap.near",
    decimals: 24,
    chain_id: null,
    symbol: "wNEAR",
  },
  arb_usdc: {
    asset_id: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    token_contract: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    decimals: 6,
    chain_id: 42161,
    symbol: "USDC",
  },
});

/**
 * Mirror of policy slippage floor (raw amount_in units — known mismatch risk).
 */
export function policySlippageFloorOk(amountIn, minAmountOut, maxSlippageBps) {
  const minRatio = 10_000n - BigInt(maxSlippageBps);
  const floor = (BigInt(amountIn) * minRatio) / 10_000n;
  const minOut = BigInt(minAmountOut);
  return minOut >= floor || minOut >= BigInt(amountIn);
}

/**
 * Local policy-shaped authorization checks (no chain call).
 */
export function simulatePolicyChecks({
  attestation,
  tx,
  expectedEpoch = MAINNET_EPOCH,
  mandateEpoch = MAINNET_EPOCH,
  allowedAssets,
  allowedDestinations,
  allowedChains,
  maxTradeValue,
  maxSlippageBps = 50,
  maxGasBudget,
  usedAttestationIds = new Set(),
  trustedSigners = new Set(),
  signerPublicKey,
  nowNs,
}) {
  const fails = [];
  if (expectedEpoch !== mandateEpoch) fails.push("stale_mandate_epoch");
  if (!trustedSigners.has(signerPublicKey)) fails.push("quote_signer_not_trusted");
  if (!allowedAssets.has(attestation.asset_in)) fails.push("asset_in_not_allowed");
  if (!allowedAssets.has(attestation.asset_out)) fails.push("asset_out_not_allowed");
  if (!allowedChains.has(Number(attestation.chain_id))) fails.push("chain_id_not_allowed");
  if (!allowedDestinations.has(attestation.recipient.toLowerCase())) {
    fails.push("recipient_not_allowed");
  }
  if (!allowedDestinations.has(attestation.refund_to.toLowerCase())) {
    fails.push("refund_to_not_allowed");
  }
  if (BigInt(attestation.amount_in) > BigInt(maxTradeValue)) {
    fails.push("exceeds_max_trade_value");
  }
  if (BigInt(attestation.quote_deadline_ns) <= BigInt(nowNs)) {
    fails.push("quote_attestation_expired");
  }
  const gasCost =
    BigInt(attestation.max_gas_price) * BigInt(attestation.gas_limit);
  if (gasCost > BigInt(maxGasBudget)) fails.push("exceeds_max_gas_budget");
  if (
    !policySlippageFloorOk(
      attestation.amount_in,
      attestation.min_amount_out,
      maxSlippageBps
    )
  ) {
    fails.push("min_amount_out_below_slippage_bound");
  }
  if (tx.to.toLowerCase() !== attestation.deposit_address.toLowerCase()) {
    fails.push("tx_to_ne_deposit");
  }
  if (tx.token_contract.toLowerCase() !== attestation.token_contract.toLowerCase()) {
    fails.push("tx_token_mismatch");
  }
  if (String(tx.amount) !== String(attestation.amount_in)) {
    fails.push("tx_amount_mismatch");
  }
  if (Number(tx.chain_id) !== Number(attestation.chain_id)) {
    fails.push("tx_chain_id_mismatch");
  }
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
  const attId = attestationId(msg);
  if (usedAttestationIds.has(attId)) fails.push("attestation_already_used");

  return {
    ok: fails.length === 0,
    fails,
    attestation_id: attId,
    message_utf8: msg.toString("utf8"),
  };
}

export function buildErc20TxParams({
  depositAddress,
  tokenContract,
  amountIn,
  chainId,
  nonce = 0,
  gasPrice,
  gasLimit,
}) {
  const data = erc20TransferData(depositAddress, amountIn);
  const digest = eip155UnsignedDigest({
    nonce,
    gasPrice,
    gasLimit,
    to: tokenContract,
    value: 0n,
    data,
    chainId,
  });
  return {
    to: depositAddress.toLowerCase(),
    token_contract: tokenContract.toLowerCase(),
    amount: String(amountIn),
    chain_id: Number(chainId),
    nonce: Number(nonce),
    gas_price: String(gasPrice),
    gas_limit: String(gasLimit),
    data_hex: "0x" + Buffer.from(data).toString("hex"),
    digest_hex: digestHex(digest),
    note: "ERC-20 transfer(token, deposit, amount); tx.to in policy = deposit; digest to = token",
  };
}

/**
 * End-to-end local path for a representative route.
 * Uses locally signed 1Click response (official SDK verify) — never mainnet mutate.
 */
export function runLocalQuoteAuthorizationPath({
  route,
  amountIn,
  amountOut,
  minAmountOut,
  depositAddress,
  recipient,
  refundTo,
  managerSecretKey = nacl.sign.keyPair().secretKey,
  attestorSecretKey = nacl.sign.keyPair().secretKey,
  maxGasPrice = 5_000_000_000n,
  gasLimit = 250_000n,
  maxSlippageBps = 50,
  maxTradeValue = "100000000",
  maxGasBudget = "5000000000000000",
  mandateEpoch = MAINNET_EPOCH,
  registerAttestorLocally = true,
  mutate,
}) {
  const src = route.source;
  const dst = route.destination;
  const deadline = new Date(Date.now() + 12 * 60_000).toISOString();
  const quoteRequest = {
    dry: false, // structural funded-shape for deposit binding — not submitted to API
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: src.asset_id,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: dst.asset_id,
    amount: String(amountIn),
    refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline,
  };
  const quote = {
    amountIn: String(amountIn),
    amountInFormatted: String(Number(amountIn) / 10 ** src.decimals),
    amountInUsd: "1.00",
    minAmountIn: String(amountIn),
    amountOut: String(amountOut),
    amountOutFormatted: "x",
    amountOutUsd: "0.995",
    minAmountOut: String(minAmountOut),
    depositAddress,
    deadline,
    correlationId: `j5-${route.id}-${Date.now()}`,
  };

  let signed = buildLocallySignedQuoteResponse({
    quoteRequest,
    quote,
    secretKey64: Buffer.from(managerSecretKey),
  });
  if (typeof mutate === "function") signed = mutate(signed);

  const agentRequest = {
    originAsset: src.asset_id,
    destinationAsset: dst.asset_id,
    amount: String(amountIn),
    depositType: "ORIGIN_CHAIN",
    recipient,
    refundTo,
    dry: false,
  };

  const verified = verifySignedOneClickQuote(signed, {
    agentRequest,
    managerPublicKey: signed.manager_public_key,
  });

  const decimalsRisk = analyzeDecimalsRisk({
    amountIn,
    minAmountOut,
    decimalsIn: src.decimals,
    decimalsOut: dst.decimals,
    assetIn: src.asset_id,
    assetOut: dst.asset_id,
    maxSlippageBps,
    maxTradeValue,
  });

  if (!verified.ok) {
    return {
      ok: false,
      stage: "one_click_verify",
      route: route.id,
      verified,
      decimalsRisk,
    };
  }

  const attested = attestTidepoolQuote({
    quoteResponse: signed,
    agentRequest,
    tokenContract: src.token_contract,
    chainId: src.chain_id,
    maxGasPrice: String(maxGasPrice),
    gasLimit: String(gasLimit),
    secretKey64: Buffer.from(attestorSecretKey),
    tidepoolManagerPubKey: signed.manager_public_key,
  });

  if (!attested.ok) {
    return {
      ok: false,
      stage: "attestation",
      route: route.id,
      verified,
      attested,
      decimalsRisk,
    };
  }

  const tx = buildErc20TxParams({
    depositAddress: attested.attestation.deposit_address,
    tokenContract: attested.attestation.token_contract,
    amountIn: attested.attestation.amount_in,
    chainId: attested.attestation.chain_id,
    gasPrice: maxGasPrice,
    gasLimit,
  });

  const attestorPk = publicKeyEd25519(Buffer.from(attestorSecretKey));
  const trusted = new Set(registerAttestorLocally ? [attestorPk] : []);
  const allowedAssets = new Set([src.asset_id, dst.asset_id]);
  const allowedDestinations = new Set([
    recipient.toLowerCase(),
    refundTo.toLowerCase(),
  ]);
  // Escrow deposit is NOT required in destination allowlist (policy binds via attestation).
  const allowedChains = new Set([src.chain_id]);
  const nowNs = BigInt(Date.now()) * 1_000_000n;

  const policy = simulatePolicyChecks({
    attestation: attested.attestation,
    tx,
    expectedEpoch: mandateEpoch,
    mandateEpoch,
    allowedAssets,
    allowedDestinations,
    allowedChains,
    maxTradeValue,
    maxSlippageBps,
    maxGasBudget,
    trustedSigners: trusted,
    signerPublicKey: attestorPk,
    nowNs,
  });

  // Local ed25519 verify of our attestation
  const msg = attestationMessageV2({
    depositAddress: attested.attestation.deposit_address,
    amountIn: attested.attestation.amount_in,
    assetIn: attested.attestation.asset_in,
    assetOut: attested.attestation.asset_out,
    minAmountOut: attested.attestation.min_amount_out,
    quoteDeadlineNs: attested.attestation.quote_deadline_ns,
    tokenContract: attested.attestation.token_contract,
    chainId: attested.attestation.chain_id,
    recipient: attested.attestation.recipient,
    refundTo: attested.attestation.refund_to,
    correlationId: attested.attestation.correlation_id,
    quoteHash: attested.attestation.quote_hash,
    maxGasPrice: attested.attestation.max_gas_price,
    gasLimit: attested.attestation.gas_limit,
  });
  const sigBody = attested.signature.replace(/^ed25519:/, "");
  const sigOk = nacl.sign.detached.verify(
    msg,
    bs58.decode(sigBody),
    nacl.sign.keyPair.fromSecretKey(Buffer.from(attestorSecretKey)).publicKey
  );

  return {
    ok: policy.ok && sigOk && verified.ok && attested.ok,
    stage: "complete",
    route: route.id,
    mandate_epoch: mandateEpoch,
    verified: { ok: verified.ok, quote_hash: verified.quote_hash },
    attestation: attested.attestation,
    attestation_signature: attested.signature,
    attestation_id: attested.attestation_id,
    attestation_sig_ok: sigOk,
    tx,
    deposit_is_escrow:
      tx.to.toLowerCase() === depositAddress.toLowerCase() &&
      attested.attestation.deposit_address.toLowerCase() ===
        depositAddress.toLowerCase(),
    recipient_custody: recipient.toLowerCase(),
    refund_custody: refundTo.toLowerCase(),
    policy,
    decimalsRisk,
    broadcast: false,
    mainnet_submit: false,
  };
}
