#!/usr/bin/env node
/**
 * Gates E1 / E2 / E3 — security before product.
 *
 * E1: Dynamic quote authorization via trusted attestor (no per-deposit allowlist).
 * E2: On-chain EIP-155 digest binding; adversarial preimage substitution fails.
 * E3: Sign A → revoke mandate → broadcast A; prove B rejected. Do NOT assume
 *     quote deadline revokes the EVM signature.
 *
 * Ledger: NONE (software faucet keys). No mainnet funds.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import { hexToBytes } from "@noble/curves/abstract/utils";
import { secp256k1 } from "@noble/curves/secp256k1";
import * as nearAPI from "near-api-js";
import { verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";
import {
  attestationMessage,
  signAttestation,
  publicKeyEd25519,
  eip155UnsignedDigest,
  digestHex,
  erc20TransferData,
  serializeSignedTx,
} from "../packages/intents-codec/quote-auth.mjs";
import {
  evmAddressFromNearSecpKey,
  evmAddressFromPubkey,
} from "../packages/intents-codec/eip191.mjs";

const { connect, keyStores, KeyPair } = nearAPI;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CREDS = join(ROOT, ".near-credentials", "testnet");
const EVIDENCE = join(ROOT, "evidence", "live");
const MPC = "v1.signer-prod.testnet";
const RPC = "https://rpc.testnet.near.org";
const NETWORK = "testnet";
const TIDEPOOL = "https://www.usetidepool.tech";
const SEPOLIA = "https://ethereum-sepolia-rpc.publicnode.com";
const CHAIN_ID = 11155111n;
const USDC_SEPOLIA = "0x2e6AD9E6D59bB4585ea0E6762c3b637dde29DAD2";
const ORIGIN_ASSET =
  "nep141:eth-0x2e6ad9e6d59bb4585ea0e6762c3b637dde29dad2.tp-omft.testnet";
const DEST_ASSET = "nep141:wnear.tidepool-sandbox.testnet";
const BURN = "0x000000000000000000000000000000000000dEaD";
const AMOUNT_E3 = "100000"; // 0.1 USDC — harmless expendable

mkdirSync(EVIDENCE, { recursive: true });
function save(name, obj) {
  writeFileSync(join(EVIDENCE, name), JSON.stringify(obj, null, 2));
  console.log("wrote", name);
}

async function nearRpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "e", method, params }),
  });
  return res.json();
}

async function viewFunction(accountId, methodName, args = {}) {
  const json = await nearRpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: accountId,
    method_name: methodName,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (json.error) throw new Error(JSON.stringify(json.error));
  if (!json.result?.result) throw new Error(`empty view ${methodName}`);
  const raw = Buffer.from(json.result.result).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function eth(method, params) {
  const res = await fetch(SEPOLIA, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

function findWasm() {
  const p = join(
    ROOT,
    "contracts",
    "policy",
    "target",
    "wasm32-unknown-unknown",
    "release",
    "policy.wasm"
  );
  if (!existsSync(p)) throw new Error("missing policy.wasm");
  return p;
}

function extractSig(fullTx) {
  const out = { found: false };
  for (const r of fullTx?.result?.receipts_outcome || []) {
    const sv = r?.outcome?.status?.SuccessValue;
    if (!sv) continue;
    try {
      const decoded = Buffer.from(sv, "base64").toString("utf8");
      if (decoded.includes("Secp256k1") || decoded.includes("big_r")) {
        out.found = true;
        out.signature_json = JSON.parse(decoded);
        out.executor_id = r.outcome.executor_id;
      }
    } catch {
      /* continue */
    }
  }
  return out;
}

function mpcToRsV(sig) {
  const rPoint = hexToBytes(sig.big_r.affine_point);
  const r = rPoint.slice(1);
  const s = hexToBytes(sig.s.scalar);
  let recoveryId = Number(sig.recovery_id);
  if (recoveryId === 27 || recoveryId === 28) recoveryId -= 27;
  return { r, s, recoveryId };
}

function recoverFromHash(hash, r, s, recoveryId) {
  const compact = new Uint8Array(64);
  compact.set(r, 0);
  compact.set(s, 32);
  const pub = secp256k1.Signature.fromCompact(compact)
    .addRecoveryBit(recoveryId)
    .recoverPublicKey(hash);
  return evmAddressFromPubkey(pub.toRawBytes(false));
}

async function tryCall(label, fn) {
  try {
    const res = await fn();
    return { label, ok: true, tx: res?.transaction?.hash || null };
  } catch (e) {
    return { label, ok: false, error: String(e).slice(0, 500) };
  }
}

async function main() {
  const gateC = JSON.parse(readFileSync(join(EVIDENCE, "gate-c-evidence.json"), "utf8"));
  const ownerId = gateC.accounts.owner.account_id;
  const agentId = gateC.accounts.agent.account_id;
  const contractId = gateC.accounts.contract.account_id;
  const EVM = gateC.steps.derived.signerId.toLowerCase();

  const out = {
    gate: "E",
    started_at: new Date().toISOString(),
    identities: { EVM, agentId, contractId, ownerId },
    e1: {},
    e2: {},
    e3: {},
    verdicts: {},
    limitations: [],
  };

  const keyStore = new keyStores.InMemoryKeyStore();
  for (const id of [ownerId, agentId, contractId]) {
    const cred = JSON.parse(readFileSync(join(CREDS, `${id}.json`), "utf8"));
    await keyStore.setKey(NETWORK, id, KeyPair.fromString(cred.private_key));
  }
  const near = await connect({ networkId: NETWORK, nodeUrl: RPC, deps: { keyStore } });
  const owner = await near.account(ownerId);
  const agent = await near.account(agentId);
  const contractAccount = await near.account(contractId);

  // ── Upgrade + unrevoke ────────────────────────────────────────────────
  const wasm = readFileSync(findWasm());
  const deployRes = await contractAccount.deployContract(wasm);
  out.upgrade = { tx: deployRes.transaction.hash, wasm_bytes: wasm.length };
  save("gate-e-00-upgrade.json", out.upgrade);

  const rev = await viewFunction(contractId, "get_revocation_status");
  if (rev.revoked) {
    const u = await owner.functionCall({
      contractId,
      methodName: "unrevoke",
      args: {},
      gas: BigInt("30000000000000"),
      attachedDeposit: 0n,
    });
    out.unrevoke = { tx: u.transaction.hash };
  }

  // Policy: assets allowed, destinations do NOT include dynamic deposits
  const limits = {
    max_trade_value: "100000000",
    daily_turnover_limit: "1000000000",
    max_pending_exposure: "100000000",
    max_slippage_bps: 100,
    allowed_assets: [ORIGIN_ASSET, DEST_ASSET, "USDC", "NEAR"],
    allowed_destinations: ["bob.testnet", ownerId],
    valid_until: "1893456000000000000",
  };
  const setPolicy = await owner.functionCall({
    contractId,
    methodName: "set_policy",
    args: {
      limits,
      policy_hash: "gate-e-security-v1",
      strategy_hash: "e1-e2-e3",
    },
    gas: BigInt("50000000000000"),
    attachedDeposit: 0n,
  });
  out.set_policy = {
    tx: setPolicy.transaction.hash,
    note: "No per-deposit allowlist — only bob.testnet/owner",
  };

  // Attestor key (owner-configured trusted quote signer)
  const attestorSk = nacl.sign.keyPair.fromSeed(randomBytes(32)).secretKey;
  const attestorPk = publicKeyEd25519(attestorSk);
  const setSigner = await owner.functionCall({
    contractId,
    methodName: "set_trusted_quote_signer",
    args: { public_key: attestorPk },
    gas: BigInt("30000000000000"),
    attachedDeposit: 0n,
  });
  const trusted = await viewFunction(contractId, "is_trusted_quote_signer", {
    public_key: attestorPk,
  });
  out.e1.trusted_signer = {
    public_key: attestorPk,
    set_tx: setSigner.transaction.hash,
    is_trusted: trusted,
  };

  // ── E1: Tidepool quote + attestation without deposit allowlist ────────
  const deadline = new Date(Date.now() + 45 * 60 * 1000).toISOString();
  const quoteReq = {
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: ORIGIN_ASSET,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: DEST_ASSET,
    amount: "1000000",
    refundTo: EVM,
    refundType: "ORIGIN_CHAIN",
    recipient: EVM,
    recipientType: "INTENTS",
    deadline,
  };
  const quoteHttp = await fetch(`${TIDEPOOL}/v0/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(quoteReq),
  });
  const quoteBody = await quoteHttp.json();
  const depositAddress = quoteBody?.quote?.depositAddress;
  const prodVerify = verifyQuoteSignature(quoteBody);
  out.e1.tidepool_quote = {
    http_status: quoteHttp.status,
    depositAddress,
    amountIn: quoteBody?.quote?.amountIn,
    minAmountOut: quoteBody?.quote?.minAmountOut,
    quote_deadline: quoteBody?.quote?.deadline,
    signature: quoteBody?.signature,
    verify_against_prod_1click_manager: prodVerify,
  };
  if (!prodVerify) {
    out.limitations.push(
      "Tidepool maker ed25519 pubkey is not published / does not match 1Click SDK manager key; E1 uses owner-configured trusted attestor after structural quote checks."
    );
  }

  const epoch = await viewFunction(contractId, "get_mandate_epoch");
  const quoteDeadlineNs = String(
    BigInt(Date.parse(quoteBody.quote.deadline || deadline)) * 1_000_000n
  );

  function buildAttestation(overrides = {}) {
    return {
      deposit_address: (overrides.deposit_address || depositAddress).toLowerCase(),
      amount_in: overrides.amount_in || quoteBody.quote.amountIn,
      asset_in: ORIGIN_ASSET,
      asset_out: DEST_ASSET,
      min_amount_out: overrides.min_amount_out || quoteBody.quote.minAmountOut,
      quote_deadline_ns: overrides.quote_deadline_ns || quoteDeadlineNs,
      token_contract: USDC_SEPOLIA.toLowerCase(),
      chain_id: String(CHAIN_ID),
    };
  }

  function signAuth(att) {
    const msg = attestationMessage({
      depositAddress: att.deposit_address,
      amountIn: att.amount_in,
      assetIn: att.asset_in,
      assetOut: att.asset_out,
      minAmountOut: att.min_amount_out,
      quoteDeadlineNs: att.quote_deadline_ns,
      tokenContract: att.token_contract,
      chainId: att.chain_id,
    });
    return { msg, signature: signAttestation(msg, attestorSk) };
  }

  // Negative: expired attestation
  const expiredAtt = buildAttestation({
    quote_deadline_ns: String(BigInt(Date.now()) * 1_000_000n - 1_000_000_000n),
  });
  const expiredSig = signAuth(expiredAtt).signature;
  out.e1.negative_expired = await tryCall("expired", () =>
    agent.functionCall({
      contractId,
      methodName: "propose_quoted_evm_transfer",
      args: {
        operation_id: `e1-exp-${Date.now()}`,
        attestation: expiredAtt,
        attestation_signature: expiredSig,
        signer_public_key: attestorPk,
        tx: {
          nonce: "0",
          gas_price: "1000000000",
          gas_limit: "200000",
          chain_id: String(CHAIN_ID),
          token_contract: USDC_SEPOLIA,
          to: depositAddress,
          amount: quoteBody.quote.amountIn,
        },
        expected_epoch: epoch,
      },
      gas: BigInt("80000000000000"),
      attachedDeposit: 0n,
    })
  );

  // Negative: untrusted signer
  const evilKp = nacl.sign.keyPair.fromSeed(randomBytes(32));
  const evilPk = publicKeyEd25519(evilKp.secretKey);
  const goodAtt = buildAttestation();
  const evilSig = signAttestation(
    attestationMessage({
      depositAddress: goodAtt.deposit_address,
      amountIn: goodAtt.amount_in,
      assetIn: goodAtt.asset_in,
      assetOut: goodAtt.asset_out,
      minAmountOut: goodAtt.min_amount_out,
      quoteDeadlineNs: goodAtt.quote_deadline_ns,
      tokenContract: goodAtt.token_contract,
      chainId: goodAtt.chain_id,
    }),
    evilKp.secretKey
  );
  out.e1.negative_untrusted_signer = await tryCall("untrusted", () =>
    agent.functionCall({
      contractId,
      methodName: "propose_quoted_evm_transfer",
      args: {
        operation_id: `e1-evil-${Date.now()}`,
        attestation: goodAtt,
        attestation_signature: evilSig,
        signer_public_key: evilPk,
        tx: {
          nonce: "0",
          gas_price: "1000000000",
          gas_limit: "200000",
          chain_id: String(CHAIN_ID),
          token_contract: USDC_SEPOLIA,
          to: depositAddress,
          amount: quoteBody.quote.amountIn,
        },
        expected_epoch: epoch,
      },
      gas: BigInt("80000000000000"),
      attachedDeposit: 0n,
    })
  );

  // Positive E1 path uses burn transfer fields for dry-run reserve? 
  // For E1 we only need to prove propose succeeds without allowlisting deposit.
  // Use quote deposit + amount but we won't broadcast this one (E3 uses burn).
  const nonceHex = (await eth("eth_getTransactionCount", [EVM, "pending"])).result;
  let gasPrice = BigInt((await eth("eth_gasPrice", [])).result || "0");
  if (gasPrice < 1_000_000_000n) gasPrice = 1_000_000_000n;
  gasPrice = (gasPrice * 120n) / 100n;
  const gasLimit = 250000n;
  const nonce = BigInt(nonceHex);

  const att = buildAttestation();
  const { signature: attSig } = signAuth(att);
  const txParams = {
    nonce: nonce.toString(),
    gas_price: gasPrice.toString(),
    gas_limit: gasLimit.toString(),
    chain_id: String(CHAIN_ID),
    token_contract: USDC_SEPOLIA.toLowerCase(),
    to: depositAddress.toLowerCase(),
    amount: quoteBody.quote.amountIn,
  };
  const expectedDigest = digestHex(
    eip155UnsignedDigest({
      nonce,
      gasPrice,
      gasLimit,
      to: USDC_SEPOLIA,
      data: erc20TransferData(depositAddress, quoteBody.quote.amountIn),
      chainId: CHAIN_ID,
    })
  );

  const opE1 = `e1-ok-${Date.now()}`;
  const proposeE1 = await tryCall("e1-propose", () =>
    agent.functionCall({
      contractId,
      methodName: "propose_quoted_evm_transfer",
      args: {
        operation_id: opE1,
        attestation: att,
        attestation_signature: attSig,
        signer_public_key: attestorPk,
        tx: txParams,
        expected_epoch: epoch,
      },
      gas: BigInt("100000000000000"),
      attachedDeposit: 0n,
    })
  );
  out.e1.positive_propose = {
    ...proposeE1,
    operation_id: opE1,
    deposit_not_in_allowlist: true,
    allowlist: limits.allowed_destinations,
    expected_digest: expectedDigest,
  };

  let pendingE1 = null;
  if (proposeE1.ok) {
    pendingE1 = await viewFunction(contractId, "get_pending", { operation_id: opE1 });
    out.e1.pending = pendingE1;
    out.e1.digest_match =
      pendingE1?.payload_commitment === expectedDigest;
  }

  // Settle/cancel E1 reservation so exposure frees for E3
  if (proposeE1.ok) {
    await owner.functionCall({
      contractId,
      methodName: "mark_settlement",
      args: { operation_id: opE1, settlement_state: "Expired" },
      gas: BigInt("30000000000000"),
      attachedDeposit: 0n,
    });
  }

  out.verdicts.E1 = {
    status:
      proposeE1.ok &&
      !out.e1.negative_expired.ok &&
      !out.e1.negative_untrusted_signer.ok &&
      out.e1.digest_match
        ? "PASS"
        : "FAIL",
    trusted_signer_configured: !!trusted,
    unattended_without_deposit_allowlist: !!proposeE1.ok,
    expired_rejected: !out.e1.negative_expired.ok,
    untrusted_signer_rejected: !out.e1.negative_untrusted_signer.ok,
    tidepool_direct_verify: prodVerify ? "PASS" : "BLOCKED",
    note: prodVerify
      ? "Tidepool signature verified against configured manager key"
      : "Tidepool maker pubkey unpublished; attestation trust root is owner-pinned ed25519 key",
  };
  save("gate-e1-evidence.json", { e1: out.e1, verdict: out.verdicts.E1, limitations: out.limitations });

  // ── E2: adversarial preimage substitution ─────────────────────────────
  const epoch2 = await viewFunction(contractId, "get_mandate_epoch");

  // 2a: attestation deposit A, tx.to = burn (mismatch)
  const attA = buildAttestation();
  const sigA = signAuth(attA).signature;
  out.e2.mismatch_to = await tryCall("mismatch-to", () =>
    agent.functionCall({
      contractId,
      methodName: "propose_quoted_evm_transfer",
      args: {
        operation_id: `e2-mis-${Date.now()}`,
        attestation: attA,
        attestation_signature: sigA,
        signer_public_key: attestorPk,
        tx: {
          ...txParams,
          to: BURN.toLowerCase(),
          amount: attA.amount_in,
        },
        expected_epoch: epoch2,
      },
      gas: BigInt("100000000000000"),
      attachedDeposit: 0n,
    })
  );

  // 2b: amount mismatch
  out.e2.mismatch_amount = await tryCall("mismatch-amount", () =>
    agent.functionCall({
      contractId,
      methodName: "propose_quoted_evm_transfer",
      args: {
        operation_id: `e2-amt-${Date.now()}`,
        attestation: attA,
        attestation_signature: sigA,
        signer_public_key: attestorPk,
        tx: {
          ...txParams,
          to: depositAddress.toLowerCase(),
          amount: "1",
        },
        expected_epoch: epoch2,
      },
      gas: BigInt("100000000000000"),
      attachedDeposit: 0n,
    })
  );

  // 2c: legacy propose_trade with agent-supplied fake commitment to 0x dest
  out.e2.legacy_agent_commitment = await tryCall("legacy-0x", () =>
    agent.functionCall({
      contractId,
      methodName: "propose_trade",
      args: {
        proposal: {
          operation_id: `e2-leg-${Date.now()}`,
          amount_in: "1000000",
          asset_in: ORIGIN_ASSET,
          asset_out: DEST_ASSET,
          destination: BURN,
          min_amount_out: "1000000",
          intent_deadline: String(BigInt(Date.now()) * 1_000_000n + 3_600_000_000_000n),
          payload_commitment: "aa".repeat(32),
        },
      },
      gas: BigInt("50000000000000"),
      attachedDeposit: 0n,
    })
  );

  out.verdicts.E2 = {
    status:
      !out.e2.mismatch_to.ok &&
      !out.e2.mismatch_amount.ok &&
      !out.e2.legacy_agent_commitment.ok
        ? "PASS"
        : "FAIL",
    mismatch_to_rejected: !out.e2.mismatch_to.ok,
    mismatch_amount_rejected: !out.e2.mismatch_amount.ok,
    legacy_agent_evm_commitment_rejected: !out.e2.legacy_agent_commitment.ok,
    note: "Digest is keccak(RLP(EIP-155)) computed on-chain from attested fields; agent cannot supply an alternate preimage.",
  };
  save("gate-e2-evidence.json", { e2: out.e2, verdict: out.verdicts.E2 });

  // ── E3: sign A, revoke, broadcast A; B rejected ───────────────────────
  const epoch3 = await viewFunction(contractId, "get_mandate_epoch");
  const nonce3 = BigInt((await eth("eth_getTransactionCount", [EVM, "pending"])).result);
  let gasPrice3 = BigInt((await eth("eth_gasPrice", [])).result || "0");
  if (gasPrice3 < 1_000_000_000n) gasPrice3 = 1_000_000_000n;
  gasPrice3 = (gasPrice3 * 150n) / 100n;
  const gasLimit3 = 250000n;

  const attB = {
    deposit_address: BURN.toLowerCase(),
    amount_in: AMOUNT_E3,
    asset_in: ORIGIN_ASSET,
    asset_out: DEST_ASSET,
    min_amount_out: AMOUNT_E3,
    quote_deadline_ns: String(BigInt(Date.now()) * 1_000_000n + 3_600_000_000_000n),
    token_contract: USDC_SEPOLIA.toLowerCase(),
    chain_id: String(CHAIN_ID),
  };
  const { signature: attSigB } = signAuth(attB);
  const dataB = erc20TransferData(BURN, AMOUNT_E3);
  const digestB = eip155UnsignedDigest({
    nonce: nonce3,
    gasPrice: gasPrice3,
    gasLimit: gasLimit3,
    to: USDC_SEPOLIA,
    data: dataB,
    chainId: CHAIN_ID,
  });
  const opA = `e3-a-${Date.now()}`;
  const proposeA = await agent.functionCall({
    contractId,
    methodName: "propose_quoted_evm_transfer",
    args: {
      operation_id: opA,
      attestation: attB,
      attestation_signature: attSigB,
      signer_public_key: attestorPk,
      tx: {
        nonce: nonce3.toString(),
        gas_price: gasPrice3.toString(),
        gas_limit: gasLimit3.toString(),
        chain_id: String(CHAIN_ID),
        token_contract: USDC_SEPOLIA.toLowerCase(),
        to: BURN.toLowerCase(),
        amount: AMOUNT_E3,
      },
      expected_epoch: epoch3,
    },
    gas: BigInt("100000000000000"),
    attachedDeposit: 0n,
  });
  out.e3.propose_a = { ok: true, tx: proposeA.transaction.hash, operation_id: opA };

  const signA = await agent.functionCall({
    contractId,
    methodName: "request_signature",
    args: { operation_id: opA },
    gas: BigInt("300000000000000"),
    attachedDeposit: 1n,
  });
  const signTxA = signA.transaction.hash;
  const fullA = await nearRpc("EXPERIMENTAL_tx_status", [signTxA, agentId]);
  const extractedA = extractSig(fullA);
  out.e3.sign_a = {
    tx: signTxA,
    found: extractedA.found,
    digest: digestHex(digestB),
  };
  if (!extractedA.found) {
    out.verdicts.E3 = { status: "FAIL", reason: "MPC signature A missing" };
    save("gate-e-evidence.json", out);
    throw new Error("E3: no signature A");
  }

  let { r, s, recoveryId } = mpcToRsV(extractedA.signature_json);
  let recovered = recoverFromHash(digestB, r, s, recoveryId);
  if (recovered.toLowerCase() !== EVM) {
    const alt = recoveryId ^ 1;
    if (recoverFromHash(digestB, r, s, alt).toLowerCase() === EVM) {
      recoveryId = alt;
      recovered = EVM;
    }
  }
  out.e3.recover_a = { recovered, matches: recovered.toLowerCase() === EVM };

  // HOLD raw tx — revoke BEFORE broadcast
  const rawA = serializeSignedTx({
    nonce: nonce3,
    gasPrice: gasPrice3,
    gasLimit: gasLimit3,
    to: USDC_SEPOLIA,
    data: dataB,
    chainId: CHAIN_ID,
    r,
    s,
    recoveryId,
  });

  const revoke = await owner.functionCall({
    contractId,
    methodName: "revoke",
    args: {},
    gas: BigInt("30000000000000"),
    attachedDeposit: 0n,
  });
  out.e3.revoke = {
    tx: revoke.transaction.hash,
    status: await viewFunction(contractId, "get_revocation_status"),
  };

  // Broadcast A after revoke
  const sendA = await eth("eth_sendRawTransaction", [rawA]);
  out.e3.broadcast_a = { result: sendA.result, error: sendA.error || null };
  let receiptA = null;
  if (sendA.result) {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const rr = await eth("eth_getTransactionReceipt", [sendA.result]);
      if (rr.result) {
        receiptA = rr.result;
        break;
      }
    }
  }
  out.e3.receipt_a = {
    hash: sendA.result,
    status: receiptA?.status || null,
    gasUsed: receiptA?.gasUsed || null,
    blockNumber: receiptA?.blockNumber || null,
    executed_after_near_revoke: receiptA?.status === "0x1",
  };

  // Propose B after revoke — must fail
  out.e3.propose_b_after_revoke = await tryCall("propose-b", () =>
    agent.functionCall({
      contractId,
      methodName: "propose_quoted_evm_transfer",
      args: {
        operation_id: `e3-b-${Date.now()}`,
        attestation: attB,
        attestation_signature: attSigB,
        signer_public_key: attestorPk,
        tx: {
          nonce: (nonce3 + 1n).toString(),
          gas_price: gasPrice3.toString(),
          gas_limit: gasLimit3.toString(),
          chain_id: String(CHAIN_ID),
          token_contract: USDC_SEPOLIA.toLowerCase(),
          to: BURN.toLowerCase(),
          amount: AMOUNT_E3,
        },
        expected_epoch: epoch3,
      },
      gas: BigInt("100000000000000"),
      attachedDeposit: 0n,
    })
  );

  const aExecuted = out.e3.receipt_a.executed_after_near_revoke === true;
  const bRejected = !out.e3.propose_b_after_revoke.ok;
  out.verdicts.E3 = {
    status:
      extractedA.found && bRejected && receiptA
        ? "PASS"
        : extractedA.found && bRejected
          ? "PARTIAL"
          : "FAIL",
    a_signed_before_revoke: extractedA.found,
    a_executed_on_sepolia_after_near_revoke: aExecuted,
    b_rejected_after_revoke: bRejected,
    security_limitation: aExecuted
      ? "NEAR mandate revoke does NOT invalidate an already-exported ECDSA signature; pre-revoke signed EVM tx A still mined successfully."
      : "A did not execute after revoke; see receipt — not proof that revoke invalidated ECDSA (could be gas/broadcast).",
    note: "Quote/attestation deadline does not revoke EVM signatures. Revoke only blocks NEW MPC signing (B).",
  };

  out.limitations.push(out.verdicts.E3.security_limitation);
  save("gate-e3-evidence.json", { e3: out.e3, verdict: out.verdicts.E3 });

  out.finished_at = new Date().toISOString();
  save("gate-e-evidence.json", out);
  console.log(JSON.stringify(out.verdicts, null, 2));
  console.log("limitations:", out.limitations);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
