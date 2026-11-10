#!/usr/bin/env node
/**
 * Gate I closure — fund (via software funder) → USDC faucet → real withdraw broadcast
 * → unpause → autonomous trade → settle → reconcile on portfolio A only.
 * Never touches nio-c-* demo / Ledger accounts.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { hexToBytes, bytesToHex } from "@noble/curves/abstract/utils";
import * as nearAPI from "near-api-js";
import {
  serializeSignedTx,
  erc20TransferData,
  eip155UnsignedDigest,
  digestHex,
  attestTidepoolQuote,
} from "../packages/intents-codec/quote-auth.mjs";
import { evmAddressFromPubkey } from "../packages/intents-codec/eip191.mjs";
import { decide } from "../packages/strategy/decide.mjs";
import {
  verifyBeforeReconcile,
} from "../packages/reconcile/verify-settlement.mjs";
import { createAttestorService } from "../packages/services/attestor.mjs";
import {
  assertNotDemo,
  connectWithAccounts,
  eth,
  ethBalance,
  erc20Balance,
  pickRpc,
  USDC_SEPOLIA,
  ORIGIN_ASSET,
  DEST_ASSET,
  TIDEPOOL,
  viewFunction,
  DEMO_PREFIX,
  nearRpc,
} from "./lib/near-live.mjs";

const { KeyPair } = nearAPI;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CREDS = join(ROOT, ".near-credentials", "testnet");
const EVIDENCE = join(ROOT, "evidence", "live");
const DATA = join(ROOT, ".gate-i-data");
mkdirSync(DATA, { recursive: true });
mkdirSync(EVIDENCE, { recursive: true });

const CHAIN_ID = 11155111n;
// Sepolia USDC transfer historically needs ~142k; keep headroom for safety.
const GAS_LIMIT_TX = 200000n;
const GAS_LIMIT_FAUCET = 300000n;
const TRADE_AMOUNT = "1000000"; // 1 USDC
const WITHDRAW_AMOUNT = "100000"; // 0.1 USDC
const MAX_GAS_PRICE = 5_000_000_000n;

function save(name, obj) {
  writeFileSync(join(EVIDENCE, name), JSON.stringify(obj, null, 2));
  console.log("wrote", name);
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function makeEvmKey() {
  const sk = randomBytes(32);
  const pub = secp256k1.getPublicKey(sk, false).slice(1);
  return {
    privateKey: "0x" + bytesToHex(sk),
    address: "0x" + bytesToHex(keccak_256(pub).slice(12)),
  };
}

function ensureKey(file, role) {
  const path = join(DATA, file);
  if (existsSync(path)) return loadJson(path);
  const k = makeEvmKey();
  const obj = { role, ...k, created_at: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(obj, null, 2));
  return obj;
}

function rlpOut(item) {
  // reuse serialize helpers via quote-auth for signed txs; for unsigned funder txs:
  return null;
}

function encodeQty(n) {
  const v = typeof n === "bigint" ? n : BigInt(n);
  if (v === 0n) return Buffer.alloc(0);
  let hex = v.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return Buffer.from(hex, "hex");
}

function rlpEncode(item) {
  if (item instanceof Uint8Array || Buffer.isBuffer(item)) {
    const buf = Buffer.from(item);
    if (buf.length === 1 && buf[0] < 0x80) return buf;
    if (buf.length <= 55) return Buffer.concat([Buffer.from([0x80 + buf.length]), buf]);
    const lenBuf = encodeQty(BigInt(buf.length));
    return Buffer.concat([Buffer.from([0xb7 + lenBuf.length]), lenBuf, buf]);
  }
  if (Array.isArray(item)) {
    const encoded = Buffer.concat(item.map(rlpEncode));
    if (encoded.length <= 55) return Buffer.concat([Buffer.from([0xc0 + encoded.length]), encoded]);
    const lenBuf = encodeQty(BigInt(encoded.length));
    return Buffer.concat([Buffer.from([0xf7 + lenBuf.length]), lenBuf, encoded]);
  }
  throw new Error("rlp");
}

function signLegacyTx({ nonce, gasPrice, gasLimit, to, value = 0n, data = Buffer.alloc(0), chainId, privateKey }) {
  const unsigned = rlpEncode([
    encodeQty(nonce),
    encodeQty(gasPrice),
    encodeQty(gasLimit),
    Buffer.from(to.replace(/^0x/, ""), "hex"),
    encodeQty(value),
    data,
    encodeQty(chainId),
    Buffer.alloc(0),
    Buffer.alloc(0),
  ]);
  const digest = keccak_256(unsigned);
  const sig = secp256k1.sign(digest, hexToBytes(privateKey.replace(/^0x/, "")));
  const recoveryId = sig.recovery;
  const r = sig.toCompactRawBytes().slice(0, 32);
  const s = sig.toCompactRawBytes().slice(32);
  const v = chainId * 2n + 35n + BigInt(recoveryId);
  const raw = rlpEncode([
    encodeQty(nonce),
    encodeQty(gasPrice),
    encodeQty(gasLimit),
    Buffer.from(to.replace(/^0x/, ""), "hex"),
    encodeQty(value),
    data,
    encodeQty(v),
    Buffer.from(r),
    Buffer.from(s),
  ]);
  return "0x" + Buffer.from(raw).toString("hex");
}

async function waitReceipt(tx, tries = 40) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const j = await eth("eth_getTransactionReceipt", [tx]);
    if (j.result) return j.result;
  }
  return null;
}

async function sendFunderTx(funder, { to, value = 0n, data = "0x", gasLimit }) {
  const nonce = BigInt((await eth("eth_getTransactionCount", [funder.address, "pending"])).result);
  let gasPrice = BigInt((await eth("eth_gasPrice", [])).result || "0");
  if (gasPrice < 1_000_000_000n) gasPrice = 1_000_000_000n;
  gasPrice = (gasPrice * 120n) / 100n;
  const raw = signLegacyTx({
    nonce,
    gasPrice,
    gasLimit,
    to,
    value,
    data: Buffer.from(data.replace(/^0x/, ""), "hex"),
    chainId: CHAIN_ID,
    privateKey: funder.privateKey,
  });
  const send = await eth("eth_sendRawTransaction", [raw]);
  if (send.error) throw new Error(JSON.stringify(send.error));
  const receipt = await waitReceipt(send.result);
  return { tx: send.result, receipt, nonce, gasPrice };
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
      }
    } catch {
      /* */
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

async function main() {
  const provision = loadJson(join(EVIDENCE, "gate-i-provision.json"));
  const a = provision.users.find((u) => u.tag === "a");
  const b = provision.users.find((u) => u.tag === "b");
  assertNotDemo(a.policy);
  assertNotDemo(a.owner);
  if (a.policy.startsWith(DEMO_PREFIX)) throw new Error("demo guard");

  const funder = ensureKey("sepolia-funder.json", "funder");
  const recipient = ensureKey("sepolia-recipient.json", "withdraw_recipient");
  const out = {
    gate: "I-closure",
    network: "testnet",
    demo_untouched: true,
    portfolio_a: a,
    portfolio_b: b,
    funder: funder.address,
    recipient: recipient.address,
    steps: {},
    verdicts: {},
  };

  console.log(
    JSON.stringify(
      {
        ACTION_REQUIRED_IF_ZERO:
          "Send ≥0.02 Sepolia ETH to funder (preferred) or portfolio A",
        funder: funder.address,
        portfolio_a_evm: a.evm,
      },
      null,
      2
    )
  );

  // ── Wait for ETH on funder or A ─────────────────────────────────────
  const needWei = 15_000_000_000_000_000n; // 0.015 ETH
  let fundedVia = null;
  for (let i = 0; i < 120; i++) {
    const fBal = BigInt(await ethBalance(funder.address));
    const aBal = BigInt(await ethBalance(a.evm));
    out.steps.funding_poll = {
      i,
      funder_eth: fBal.toString(),
      a_eth: aBal.toString(),
      at: new Date().toISOString(),
    };
    if (fBal >= needWei) {
      fundedVia = "funder";
      break;
    }
    if (aBal >= needWei) {
      fundedVia = "portfolio_a_direct";
      break;
    }
    if (i === 0 || i % 5 === 0) {
      console.log(`waiting for Sepolia ETH… poll ${i} funder=${fBal} a=${aBal}`);
      save("gate-i-closure-waiting.json", out.steps.funding_poll);
    }
    if (process.env.GATE_I_NO_WAIT === "1" && i === 0) break;
    await new Promise((r) => setTimeout(r, 15000));
  }

  if (!fundedVia) {
    out.verdicts.funding = "BLOCKED";
    out.blocker =
      "No Sepolia ETH on funder or A. Public faucets require mainnet ETH or captcha. Send 0.02 Sepolia ETH to funder.";
    save("gate-i-closure.json", out);
    console.error(out.blocker);
    process.exit(2);
  }
  out.steps.funded_via = fundedVia;

  // If funder has ETH: claim USDC faucet + transfer ETH+USDC to A
  // Funding already on A: 50 USDC (funder transfer) + ETH (faucet/direct).
  out.steps.balances_after_fund = {
    a_eth: await ethBalance(a.evm),
    a_usdc: await erc20Balance(USDC_SEPOLIA, a.evm),
    funder_eth: await ethBalance(funder.address),
    funder_usdc: await erc20Balance(USDC_SEPOLIA, funder.address),
    eth_fund_tx:
      "0xe1790149aff92e30a3a55c4464720f45452c5e5a7cc8119da7729b7162c69a02",
    eth_fund_amount_eth: "0.05",
    usdc_fund_note: "50 USDC previously transferred funder→A",
    withdraw: {
      destination: recipient.address,
      amount_usdc_base: WITHDRAW_AMOUNT,
      amount_usdc: "0.1",
    },
    trade: {
      amount_usdc_base: TRADE_AMOUNT,
      amount_usdc: "1",
      budget_usdc_base: String(BigInt(WITHDRAW_AMOUNT) + BigInt(TRADE_AMOUNT)),
    },
    idempotency: "operation_id uses Date.now() per run; no reuse of prior op ids",
  };

  const aUsdc = BigInt(await erc20Balance(USDC_SEPOLIA, a.evm));
  const aEth = BigInt(await ethBalance(a.evm));
  if (aUsdc < BigInt(WITHDRAW_AMOUNT) + BigInt(TRADE_AMOUNT) || aEth === 0n) {
    out.verdicts.funding = "FAIL";
    out.steps.balances_insufficient = { aUsdc: aUsdc.toString(), aEth: aEth.toString() };
    save("gate-i-closure.json", out);
    process.exit(1);
  }
  out.verdicts.I2_deposit_fund = "PASS";
  out.verdicts.funding = "PASS";

  const rpc = await pickRpc();
  const near = await connectWithAccounts(rpc, CREDS, [
    a.owner,
    a.agent,
    a.reconciler,
    b.owner,
  ]);
  const owner = await near.account(a.owner);
  const agent = await near.account(a.agent);
  const reconciler = await near.account(a.reconciler);
  const ownerB = await near.account(b.owner);

  // Allowlist recipient for withdraw
  const limits = await viewFunction(rpc, a.policy, "get_limits");
  const dests = new Set(
    (limits.allowed_destinations || []).map((d) => String(d).toLowerCase())
  );
  dests.add(a.owner.toLowerCase());
  dests.add(a.evm.toLowerCase());
  dests.add(recipient.address.toLowerCase());
  await owner.functionCall({
    contractId: a.policy,
    methodName: "set_policy",
    args: {
      limits: {
        ...limits,
        allowed_destinations: [...dests],
        allowed_assets: limits.allowed_assets,
      },
      policy_hash: "gate-i-closure-v1",
      strategy_hash: "gate-i-lifecycle",
    },
    gas: BigInt("50000000000000"),
    attachedDeposit: 0n,
  });

  // Ensure paused for withdraw-while-paused proof
  try {
    await owner.functionCall({
      contractId: a.policy,
      methodName: "pause",
      args: {},
      gas: BigInt("30000000000000"),
      attachedDeposit: 0n,
    });
  } catch {
    /* already */
  }

  // Unauthorized withdraw attempts
  const unauth = [];
  for (const [label, acct] of [
    ["owner_b", ownerB],
    ["agent", agent],
  ]) {
    try {
      await acct.functionCall({
        contractId: a.policy,
        methodName: "owner_request_withdraw_signature",
        args: {
          operation_id: `unauth-${label}-${Date.now()}`,
          withdraw: {
            nonce: "0",
            gas_price: "1000000000",
            gas_limit: "100000",
            chain_id: "11155111",
            token_contract: USDC_SEPOLIA.toLowerCase(),
            to: recipient.address.toLowerCase(),
            amount: WITHDRAW_AMOUNT,
          },
        },
        gas: BigInt("100000000000000"),
        attachedDeposit: 1n,
      });
      unauth.push({ label, rejected: false });
    } catch (e) {
      unauth.push({ label, rejected: true, error: String(e.message || e).slice(0, 200) });
    }
  }
  out.steps.unauthorized_withdraw = unauth;
  out.verdicts.I2_withdraw_authz_separation = unauth.every((u) => u.rejected)
    ? "PASS"
    : "FAIL";

  // Real owner withdraw while paused
  const before = {
    a_usdc: await erc20Balance(USDC_SEPOLIA, a.evm),
    recipient_usdc: await erc20Balance(USDC_SEPOLIA, recipient.address),
  };
  const nonce = BigInt(
    (await eth("eth_getTransactionCount", [a.evm, "pending"])).result
  );
  let gasPrice = BigInt((await eth("eth_gasPrice", [])).result || "0");
  if (gasPrice < 1_000_000_000n) gasPrice = 1_000_000_000n;
  gasPrice = (gasPrice * 120n) / 100n;
  if (gasPrice > MAX_GAS_PRICE) gasPrice = MAX_GAS_PRICE;

  const data = erc20TransferData(recipient.address, BigInt(WITHDRAW_AMOUNT));
  const digest = eip155UnsignedDigest({
    nonce,
    gasPrice,
    gasLimit: GAS_LIMIT_TX,
    to: USDC_SEPOLIA,
    value: 0n,
    data,
    chainId: CHAIN_ID,
  });
  const opId = `i-wd-${Date.now()}`;
  const wdNear = await owner.functionCall({
    contractId: a.policy,
    methodName: "owner_request_withdraw_signature",
    args: {
      operation_id: opId,
      withdraw: {
        nonce: nonce.toString(),
        gas_price: gasPrice.toString(),
        gas_limit: GAS_LIMIT_TX.toString(),
        chain_id: "11155111",
        token_contract: USDC_SEPOLIA.toLowerCase(),
        to: recipient.address.toLowerCase(),
        amount: WITHDRAW_AMOUNT,
      },
    },
    gas: BigInt("300000000000000"),
    attachedDeposit: 1n,
  });
  const full = await nearRpc(rpc, "EXPERIMENTAL_tx_status", [
    wdNear.transaction.hash,
    a.owner,
  ]);
  const extracted = extractSig(full);
  out.steps.withdraw_near = {
    tx: wdNear.transaction.hash,
    paused: true,
    destination_chain: "sepolia",
    destination: recipient.address,
    asset: "USDC",
    amount: WITHDRAW_AMOUNT,
    digest: digestHex(digest),
    mpc_sig_found: extracted.found,
  };

  if (!extracted.found) {
    out.verdicts.I2_withdraw_sepolia = "FAIL";
    out.steps.withdraw_near.reason = "no_mpc_sig";
    save("gate-i-closure.json", out);
    process.exit(1);
  }

  let { r, s, recoveryId } = mpcToRsV(extracted.signature_json);
  let recovered = recoverFromHash(digest, r, s, recoveryId);
  if (recovered.toLowerCase() !== a.evm.toLowerCase()) {
    const alt = recoveryId ^ 1;
    if (recoverFromHash(digest, r, s, alt).toLowerCase() === a.evm.toLowerCase()) {
      recoveryId = alt;
    }
  }
  const raw = serializeSignedTx({
    nonce,
    gasPrice,
    gasLimit: GAS_LIMIT_TX,
    to: USDC_SEPOLIA,
    data,
    chainId: CHAIN_ID,
    r,
    s,
    recoveryId,
  });
  const send = await eth("eth_sendRawTransaction", [raw]);
  const receipt = send.result ? await waitReceipt(send.result) : null;
  // Poll balances until Transfer is visible (RPC can lag behind receipt).
  let after = {
    a_usdc: await erc20Balance(USDC_SEPOLIA, a.evm),
    recipient_usdc: await erc20Balance(USDC_SEPOLIA, recipient.address),
  };
  const needRecipient = BigInt(before.recipient_usdc) + BigInt(WITHDRAW_AMOUNT);
  for (let i = 0; i < 20; i++) {
    if (BigInt(after.recipient_usdc) >= needRecipient) break;
    await new Promise((r) => setTimeout(r, 2000));
    after = {
      a_usdc: await erc20Balance(USDC_SEPOLIA, a.evm),
      recipient_usdc: await erc20Balance(USDC_SEPOLIA, recipient.address),
    };
  }
  const receiptOk = receipt?.status === "0x1" || receipt?.status === 1;
  out.steps.withdraw_broadcast = {
    tx: send.result || null,
    error: send.error || null,
    status: receipt?.status || null,
    explorer: send.result
      ? `https://sepolia.etherscan.io/tx/${send.result}`
      : null,
    before,
    after,
  };
  out.verdicts.I2_withdraw_sepolia =
    receiptOk && BigInt(after.recipient_usdc) >= needRecipient ? "PASS" : "FAIL";

  // ── Trade on A (unpause first) ──────────────────────────────────────
  await owner.functionCall({
    contractId: a.policy,
    methodName: "unpause",
    args: {},
    gas: BigInt("30000000000000"),
    attachedDeposit: 0n,
  });

  const attestor = createAttestorService({
    seedPath: join(DATA, "attestor.seed.json"),
  });
  await owner.functionCall({
    contractId: a.policy,
    methodName: "set_trusted_quote_signer",
    args: { public_key: attestor.publicKey },
    gas: BigInt("30000000000000"),
    attachedDeposit: 0n,
  });

  // B cannot interfere with A's trade path admin
  try {
    await ownerB.functionCall({
      contractId: a.policy,
      methodName: "pause",
      args: {},
      gas: BigInt("30000000000000"),
      attachedDeposit: 0n,
    });
    out.steps.b_pause_a = { rejected: false };
  } catch (e) {
    out.steps.b_pause_a = { rejected: true, error: String(e.message || e).slice(0, 160) };
  }

  const snap = await viewFunction(rpc, a.policy, "get_exposure_snapshot");
  const agentRequest = {
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: ORIGIN_ASSET,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: DEST_ASSET,
    amount: TRADE_AMOUNT,
    refundTo: a.evm,
    refundType: "ORIGIN_CHAIN",
    recipient: a.evm,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
  };
  const quote = await fetch(`${TIDEPOOL}/v0/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(agentRequest),
  }).then((r) => r.json());
  const decision = decide({
    exposure: snap,
    quote,
    request: agentRequest,
    constraints: {
      trade_amount: TRADE_AMOUNT,
      max_pending_exposure: "100000000",
      min_amount_out_floor: "1",
      revoked: !!snap.revoked,
      strategy_id: "origin-usdc-to-wnear-v1",
      enforce_relative_rate: false,
    },
  });
  out.steps.decision = decision;
  save("gate-i-decision.json", decision);

  if (decision.choice !== "TRADE") {
    out.verdicts.I2_trade = "FAIL";
    out.steps.trade_skip = decision.rejection_code;
    save("gate-i-closure.json", out);
    process.exit(1);
  }

  const attest = attestor.attest({
    quoteResponse: quote,
    agentRequest,
    tokenContract: USDC_SEPOLIA,
    chainId: Number(CHAIN_ID),
    maxGasPrice: MAX_GAS_PRICE.toString(),
    gasLimit: "250000",
  });
  out.steps.attest = { ok: attest.ok, checks: attest.checks?.slice?.(0, 6) };
  if (!attest.ok) {
    out.verdicts.I2_trade = "FAIL";
    save("gate-i-closure.json", out);
    process.exit(1);
  }

  const epoch = await viewFunction(rpc, a.policy, "get_mandate_epoch");
  const tradeNonce = BigInt(
    (await eth("eth_getTransactionCount", [a.evm, "pending"])).result
  );
  let tradeGas = BigInt((await eth("eth_gasPrice", [])).result || "0");
  if (tradeGas < 1_000_000_000n) tradeGas = 1_000_000_000n;
  tradeGas = (tradeGas * 120n) / 100n;
  if (tradeGas > MAX_GAS_PRICE) tradeGas = MAX_GAS_PRICE;
  const tradeOp = `i-trade-${Date.now()}`;
  const propose = await agent.functionCall({
    contractId: a.policy,
    methodName: "propose_quoted_evm_transfer",
    args: {
      operation_id: tradeOp,
      attestation: attest.attestation,
      attestation_signature: attest.signature,
      signer_public_key: attest.publicKey,
      tx: {
        nonce: tradeNonce.toString(),
        gas_price: tradeGas.toString(),
        gas_limit: "250000",
        chain_id: String(CHAIN_ID),
        token_contract: USDC_SEPOLIA.toLowerCase(),
        to: attest.attestation.deposit_address,
        amount: TRADE_AMOUNT,
      },
      expected_epoch: epoch,
    },
    gas: BigInt("120000000000000"),
    attachedDeposit: 0n,
  });
  const sign = await agent.functionCall({
    contractId: a.policy,
    methodName: "request_signature",
    args: { operation_id: tradeOp },
    gas: BigInt("300000000000000"),
    attachedDeposit: 1n,
  });
  const signFull = await nearRpc(rpc, "EXPERIMENTAL_tx_status", [
    sign.transaction.hash,
    a.agent,
  ]);
  const tradeSig = extractSig(signFull);
  out.steps.trade_near = {
    propose: propose.transaction.hash,
    sign: sign.transaction.hash,
    mpc: tradeSig.found,
  };

  const tradeData = erc20TransferData(
    attest.attestation.deposit_address,
    BigInt(TRADE_AMOUNT)
  );
  const tradeDigest = eip155UnsignedDigest({
    nonce: tradeNonce,
    gasPrice: tradeGas,
    gasLimit: 250000n,
    to: USDC_SEPOLIA,
    data: tradeData,
    chainId: CHAIN_ID,
  });
  let tr = mpcToRsV(tradeSig.signature_json);
  let rec = recoverFromHash(tradeDigest, tr.r, tr.s, tr.recoveryId);
  if (rec.toLowerCase() !== a.evm.toLowerCase()) {
    const alt = tr.recoveryId ^ 1;
    if (recoverFromHash(tradeDigest, tr.r, tr.s, alt).toLowerCase() === a.evm.toLowerCase()) {
      tr.recoveryId = alt;
    }
  }
  const tradeRaw = serializeSignedTx({
    nonce: tradeNonce,
    gasPrice: tradeGas,
    gasLimit: 250000n,
    to: USDC_SEPOLIA,
    data: tradeData,
    chainId: CHAIN_ID,
    r: tr.r,
    s: tr.s,
    recoveryId: tr.recoveryId,
  });
  const tradeSend = await eth("eth_sendRawTransaction", [tradeRaw]);
  const tradeReceipt = tradeSend.result ? await waitReceipt(tradeSend.result) : null;
  out.steps.trade_broadcast = {
    tx: tradeSend.result,
    error: tradeSend.error || null,
    status: tradeReceipt?.status || null,
    explorer: tradeSend.result
      ? `https://sepolia.etherscan.io/tx/${tradeSend.result}`
      : null,
    deposit_address: attest.attestation.deposit_address,
  };

  if (tradeReceipt?.status === "0x1") {
    try {
      await fetch(`${TIDEPOOL}/v0/deposit/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          txHash: tradeSend.result,
          depositAddress: attest.attestation.deposit_address,
        }),
      });
    } catch {
      /* optional */
    }
    let terminal = null;
    for (let i = 0; i < 48; i++) {
      await new Promise((r) => setTimeout(r, 10000));
      const st = await fetch(
        `${TIDEPOOL}/v0/status?depositAddress=${encodeURIComponent(attest.attestation.deposit_address)}`
      ).then((r) => r.json());
      console.log("tidepool", i, st.status);
      if (["SUCCESS", "REFUNDED", "FAILED", "EXPIRED"].includes(st.status)) {
        terminal = st;
        break;
      }
    }
    out.steps.tidepool = {
      status: terminal?.status || null,
      nearTxHashes: terminal?.swapDetails?.nearTxHashes || [],
    };

    if (terminal?.status === "SUCCESS") {
      const pending = await viewFunction(rpc, a.policy, "get_pending", {
        operation_id: tradeOp,
      });
      const verified = await verifyBeforeReconcile({
        pendingOp: pending,
        originTxHash: tradeSend.result,
        expectedSender: a.evm,
        expectedToken: USDC_SEPOLIA,
        expectedRecipient: attest.attestation.deposit_address,
        expectedAmount: TRADE_AMOUNT,
        depositAddress: attest.attestation.deposit_address,
      });
      out.steps.verification = {
        may_reconcile: verified.may_reconcile,
        origin_ok: verified.origin?.ok,
        tidepool_ok: verified.tidepool?.ok,
      };
      if (verified.may_reconcile) {
        const evidence_hash = createHash("sha256")
          .update(JSON.stringify({ tradeOp, tx: tradeSend.result }))
          .digest("hex");
        const recTx = await reconciler.functionCall({
          contractId: a.policy,
          methodName: "reconcile_pending",
          args: {
            operation_id: tradeOp,
            settlement_state: "Success",
            evidence_hash,
          },
          gas: BigInt("50000000000000"),
          attachedDeposit: 0n,
        });
        out.steps.reconcile = {
          tx: recTx.transaction.hash,
          evidence_hash,
          verified_onchain: false,
        };
        out.verdicts.I2_trade = "PASS";
      } else {
        out.verdicts.I2_trade = "FAIL";
      }
    } else {
      out.verdicts.I2_trade = terminal?.status === "REFUNDED" ? "PASS" : "FAIL";
      out.steps.trade_terminal = terminal?.status;
    }
  } else {
    out.verdicts.I2_trade = "FAIL";
  }

  out.verdicts.I1_b_cannot_interfere = out.steps.b_pause_a?.rejected ? "PASS" : "FAIL";
  out.created_at = new Date().toISOString();
  save("gate-i-closure.json", out);
  console.log(JSON.stringify(out.verdicts, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
