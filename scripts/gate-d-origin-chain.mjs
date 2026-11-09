#!/usr/bin/env node
/**
 * Gate D: Funded ORIGIN_CHAIN swap via Sepolia USDC + contract-owned MPC.
 *
 * Path: Tidepool faucet credited 100 Sepolia USDC to MPC EVM (intents faucet
 * rate-limited after that claim). Quote ORIGIN_CHAIN → depositAddress,
 * policy-authorize keccak(EIP-155 tx), MPC-sign, broadcast, poll status.
 *
 * Ledger: NONE (software faucet keys). No mainnet funds.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes } from "@noble/curves/abstract/utils";
import { secp256k1 } from "@noble/curves/secp256k1";
import * as nearAPI from "near-api-js";
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
const AMOUNT = "1000000"; // 1 USDC
const PORTFOLIO = "gatec1";

mkdirSync(EVIDENCE, { recursive: true });
function save(name, obj) {
  writeFileSync(join(EVIDENCE, name), JSON.stringify(obj, null, 2));
  console.log("wrote", name);
}

async function nearRpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "d", method, params }),
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

/** Minimal RLP for legacy EIP-155 unsigned/signed txs. */
function rlpEncode(item) {
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

function bigIntToMinimalBytes(n) {
  if (n === 0n) return Buffer.alloc(0);
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return Buffer.from(hex, "hex");
}

function encodeQuantity(n) {
  return bigIntToMinimalBytes(typeof n === "bigint" ? n : BigInt(n));
}

function erc20TransferData(to, amount) {
  const sel = Buffer.from("a9059cbb", "hex");
  const addr = Buffer.from(to.replace(/^0x/, "").toLowerCase().padStart(64, "0"), "hex");
  const amt = Buffer.from(BigInt(amount).toString(16).padStart(64, "0"), "hex");
  return Buffer.concat([sel, addr, amt]);
}

function unsignedTxHash({ nonce, gasPrice, gasLimit, to, value, data, chainId }) {
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

function serializeSignedTx({
  nonce,
  gasPrice,
  gasLimit,
  to,
  value,
  data,
  chainId,
  r,
  s,
  recoveryId,
}) {
  const v = chainId * 2n + 35n + BigInt(recoveryId);
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

function mpcToRsV(sig) {
  const rPoint = hexToBytes(sig.big_r.affine_point);
  const r = rPoint.slice(1);
  const s = hexToBytes(sig.s.scalar);
  let recoveryId = Number(sig.recovery_id);
  if (recoveryId === 27 || recoveryId === 28) recoveryId -= 27;
  return { r, s, recoveryId };
}

function recoverFromTxHash(hash, r, s, recoveryId) {
  const compact = new Uint8Array(64);
  compact.set(r, 0);
  compact.set(s, 32);
  const pub = secp256k1.Signature.fromCompact(compact)
    .addRecoveryBit(recoveryId)
    .recoverPublicKey(hash);
  return evmAddressFromPubkey(pub.toRawBytes(false));
}

async function erc20Balance(token, account) {
  const data =
    "0x70a08231" + account.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const res = await eth("eth_call", [{ to: token, data }, "latest"]);
  return BigInt(res.result || "0");
}

async function main() {
  const gateC = JSON.parse(readFileSync(join(EVIDENCE, "gate-c-evidence.json"), "utf8"));
  const ownerId = gateC.accounts.owner.account_id;
  const agentId = gateC.accounts.agent.account_id;
  const contractId = gateC.accounts.contract.account_id;
  const EVM = gateC.steps.derived.signerId.toLowerCase();

  const out = {
    gate: "D",
    started_at: new Date().toISOString(),
    mode: "ORIGIN_CHAIN_SEPOLIA_USDC",
    identities: { EVM, agentId, contractId, ownerId },
    funding: {},
    steps: {},
    verdicts: {},
  };

  // ── Funding snapshot ──────────────────────────────────────────────────
  const ethBal = BigInt((await eth("eth_getBalance", [EVM, "latest"])).result);
  const usdcBal = await erc20Balance(USDC_SEPOLIA, EVM);
  out.funding = {
    sepolia_eth: ethBal.toString(),
    sepolia_eth_formatted: Number(ethBal) / 1e18,
    sepolia_usdc: usdcBal.toString(),
    sepolia_usdc_formatted: Number(usdcBal) / 1e6,
    sepolia_fund_tx:
      "0x15cd10e05d1a819a4bc9e3a889105a28ef483f0f81f5092913dbd142f438637b",
    intents_faucet: {
      note: "Ethereum Sepolia card claim succeeded (100 USDC+USDT on-chain). Subsequent Intents-mode claim for same EVM hit 429 rate limit until 2026-11-16.",
      mt_balance_before: await viewFunction(
        "verifier.tidepool-sandbox.testnet",
        "mt_balance_of",
        { account_id: EVM, token_id: "nep141:usdc.tidepool-sandbox.testnet" }
      ),
    },
  };
  save("gate-d-05-funding-sepolia.json", out.funding);
  if (usdcBal < BigInt(AMOUNT)) {
    out.verdicts.D_funding = {
      status: "BLOCKED",
      reason: "Sepolia USDC balance below swap amount",
    };
    save("gate-d-evidence.json", out);
    console.error("insufficient Sepolia USDC");
    process.exit(1);
  }
  out.verdicts.D_funding = {
    status: "PASS",
    reason: "100 Sepolia USDC on MPC-derived EVM after Tidepool site faucet",
  };

  // ── Connect NEAR ──────────────────────────────────────────────────────
  const keyStore = new keyStores.InMemoryKeyStore();
  for (const id of [ownerId, agentId, contractId]) {
    const cred = JSON.parse(readFileSync(join(CREDS, `${id}.json`), "utf8"));
    await keyStore.setKey(NETWORK, id, KeyPair.fromString(cred.private_key));
  }
  const near = await connect({ networkId: NETWORK, nodeUrl: RPC, deps: { keyStore } });
  const owner = await near.account(ownerId);
  const agent = await near.account(agentId);
  const contractAccount = await near.account(contractId);

  // ── Upgrade + unrevoke (preserve predecessor → same EVM) ──────────────
  const wasm = readFileSync(findWasm());
  const deployRes = await contractAccount.deployContract(wasm);
  out.steps.upgrade = {
    ok: true,
    transaction_hash: deployRes.transaction.hash,
    wasm_bytes: wasm.length,
  };
  save("gate-d-06-upgrade.json", out.steps.upgrade);

  const before = {
    epoch: await viewFunction(contractId, "get_mandate_epoch"),
    revoked: await viewFunction(contractId, "get_revocation_status"),
    path: await viewFunction(contractId, "get_derivation_path"),
    reserved: await viewFunction(contractId, "get_reserved_pending_exposure"),
  };
  out.steps.before_unrevoke = before;

  let unrevokeRes;
  try {
    unrevokeRes = await owner.functionCall({
      contractId,
      methodName: "unrevoke",
      args: {},
      gas: BigInt("30000000000000"),
      attachedDeposit: 0n,
    });
    out.steps.unrevoke = {
      ok: true,
      transaction_hash: unrevokeRes.transaction.hash,
    };
  } catch (e) {
    out.steps.unrevoke = { ok: false, error: String(e) };
    // already active?
  }
  save("gate-d-07-unrevoke.json", out.steps.unrevoke);

  // Clear Gate C leftover reservation (1 unit)
  try {
    const settle = await owner.functionCall({
      contractId,
      methodName: "mark_settlement",
      args: {
        operation_id: "gatec-1794223959081",
        settlement_state: "Expired",
      },
      gas: BigInt("30000000000000"),
      attachedDeposit: 0n,
    });
    out.steps.clear_gatec_pending = {
      ok: true,
      transaction_hash: settle.transaction.hash,
    };
  } catch (e) {
    out.steps.clear_gatec_pending = { ok: false, error: String(e) };
  }

  const afterUnrevoke = {
    epoch: await viewFunction(contractId, "get_mandate_epoch"),
    revoked: await viewFunction(contractId, "get_revocation_status"),
    path: await viewFunction(contractId, "get_derivation_path"),
    reserved: await viewFunction(contractId, "get_reserved_pending_exposure"),
  };
  out.steps.after_unrevoke = afterUnrevoke;
  save("gate-d-08-mandate.json", {
    before,
    unrevoke: out.steps.unrevoke,
    clear: out.steps.clear_gatec_pending,
    after: afterUnrevoke,
  });

  const derivedNearKey = await viewFunction(MPC, "derived_public_key", {
    path: afterUnrevoke.path,
    predecessor: contractId,
    domain_id: 0,
  });
  const derivedEvm = evmAddressFromNearSecpKey(derivedNearKey).toLowerCase();
  out.steps.derived = { derivedNearKey, derivedEvm, matches_funded: derivedEvm === EVM };
  save("gate-d-09-derived.json", out.steps.derived);
  if (derivedEvm !== EVM) {
    out.verdicts.D_custody = {
      status: "FAIL",
      reason: `derived ${derivedEvm} != funded ${EVM}`,
    };
    save("gate-d-evidence.json", out);
    throw new Error("custody identity drift");
  }

  // ── Live quote ────────────────────────────────────────────────────────
  const deadline = new Date(Date.now() + 45 * 60 * 1000).toISOString();
  const quoteReq = {
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: ORIGIN_ASSET,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: DEST_ASSET,
    amount: AMOUNT,
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
  out.steps.quote = { request: quoteReq, http_status: quoteHttp.status, body: quoteBody };
  save("gate-d-10-quote.json", out.steps.quote);
  const depositAddress = quoteBody?.quote?.depositAddress;
  if (!depositAddress) {
    out.verdicts.D_quote = { status: "FAIL", reason: "no depositAddress" };
    save("gate-d-evidence.json", out);
    throw new Error("no depositAddress");
  }
  out.verdicts.D_quote = {
    status: "PASS",
    depositAddress,
    amountIn: quoteBody.quote.amountIn,
    amountOut: quoteBody.quote.amountOut,
  };

  // ── Policy allowlist deposit + assets ─────────────────────────────────
  const limits = {
    max_trade_value: "100000000",
    daily_turnover_limit: "1000000000",
    max_pending_exposure: "100000000",
    max_slippage_bps: 100,
    allowed_assets: [
      ORIGIN_ASSET,
      DEST_ASSET,
      "nep141:usdc.tidepool-sandbox.testnet",
      "USDC",
      "NEAR",
    ],
    allowed_destinations: [
      depositAddress,
      depositAddress.toLowerCase(),
      EVM,
      ownerId,
      "bob.testnet",
    ],
    valid_until: "1893456000000000000",
  };
  const setPolicy = await owner.functionCall({
    contractId,
    methodName: "set_policy",
    args: {
      limits,
      policy_hash: "gate-d-origin-chain-v1",
      strategy_hash: "usdc-eth-to-wnear",
    },
    gas: BigInt("50000000000000"),
    attachedDeposit: 0n,
  });
  out.steps.set_policy = {
    ok: true,
    transaction_hash: setPolicy.transaction.hash,
    limits,
  };
  save("gate-d-11-set-policy.json", out.steps.set_policy);

  // Security: alternate destination must be rejected
  const epoch = await viewFunction(contractId, "get_mandate_epoch");
  const evilDest = "0x0000000000000000000000000000000000000bad";
  const dummyHash = "11".repeat(32);
  let evilOk = false;
  let evilErr = null;
  try {
    await agent.functionCall({
      contractId,
      methodName: "propose_trade",
      args: {
        proposal: {
          operation_id: `gated-evil-${Date.now()}`,
          amount_in: AMOUNT,
          asset_in: ORIGIN_ASSET,
          asset_out: DEST_ASSET,
          destination: evilDest,
          min_amount_out: quoteBody.quote.minAmountOut || AMOUNT,
          intent_deadline: String(BigInt(Date.now()) * 1_000_000n + 3_600_000_000_000n),
          payload_commitment: dummyHash,
        },
      },
      gas: BigInt("50000000000000"),
      attachedDeposit: 0n,
    });
    evilOk = true;
  } catch (e) {
    evilErr = String(e);
  }
  out.steps.security_deposit_bind = {
    evilDest,
    accepted: evilOk,
    error: evilErr,
    expect_reject: true,
  };
  out.verdicts.D_security_deposit_bind = {
    status: !evilOk ? "PASS" : "FAIL",
    note: "Agent cannot propose_trade to non-allowlisted deposit substitute",
  };
  save("gate-d-12-security-deposit-bind.json", out.steps.security_deposit_bind);

  // ── Build Sepolia ERC20 transfer ──────────────────────────────────────
  const nonceHex = (await eth("eth_getTransactionCount", [EVM, "pending"])).result;
  const gasPriceHex = (await eth("eth_gasPrice", [])).result;
  const nonce = BigInt(nonceHex);
  // First broadcast used ~73 wei and mined but OOG; bump floor to 1 gwei.
  const ONE_GWEI = 1_000_000_000n;
  let gasPrice = BigInt(gasPriceHex || "0");
  if (gasPrice < ONE_GWEI) gasPrice = ONE_GWEI;
  gasPrice = (gasPrice * 120n) / 100n;
  // Prior attempt OOG at 100k (gasUsed==limit). Estimate then pad.
  let gasLimit = 250000n;
  try {
    const est = await eth("eth_estimateGas", [
      {
        from: EVM,
        to: USDC_SEPOLIA,
        data: "0x" + erc20TransferData(depositAddress, AMOUNT).toString("hex"),
      },
    ]);
    if (est.result) {
      gasLimit = (BigInt(est.result) * 150n) / 100n;
      if (gasLimit < 150000n) gasLimit = 150000n;
    }
  } catch {
    /* keep default */
  }
  const data = erc20TransferData(depositAddress, AMOUNT);
  const txFields = {
    nonce,
    gasPrice,
    gasLimit,
    to: USDC_SEPOLIA,
    value: 0n,
    data,
    chainId: CHAIN_ID,
  };
  const digest = unsignedTxHash(txFields);
  const digestHex = bytesToHex(digest);
  out.steps.evm_tx = {
    nonce: nonce.toString(),
    gasPrice: gasPrice.toString(),
    gasLimit: gasLimit.toString(),
    to: USDC_SEPOLIA,
    depositAddress,
    amount: AMOUNT,
    data: "0x" + data.toString("hex"),
    digestHex,
  };
  save("gate-d-13-evm-tx.json", out.steps.evm_tx);

  const opId = `gated-${Date.now()}`;
  const intentDeadlineNs = String(
    BigInt(Date.now()) * 1_000_000n + 3_600_000_000_000n
  );
  const propose = await agent.functionCall({
    contractId,
    methodName: "propose_trade",
    args: {
      proposal: {
        operation_id: opId,
        amount_in: AMOUNT,
        asset_in: ORIGIN_ASSET,
        asset_out: DEST_ASSET,
        destination: depositAddress,
        min_amount_out: quoteBody.quote.minAmountOut,
        intent_deadline: intentDeadlineNs,
        payload_commitment: digestHex,
      },
    },
    gas: BigInt("50000000000000"),
    attachedDeposit: 0n,
  });
  out.steps.propose_trade = {
    ok: true,
    operation_id: opId,
    transaction_hash: propose.transaction.hash,
    epoch,
    digestHex,
  };
  save("gate-d-14-propose.json", out.steps.propose_trade);

  let signRes;
  let signErr = null;
  try {
    signRes = await agent.functionCall({
      contractId,
      methodName: "request_signature",
      args: { operation_id: opId },
      gas: BigInt("300000000000000"),
      attachedDeposit: 1n,
    });
  } catch (e) {
    signErr = String(e);
  }
  const signTx = signRes?.transaction?.hash;
  out.steps.request_signature = {
    ok: !!signRes && !signErr,
    transaction_hash: signTx,
    error: signErr,
    logs: signRes?.receipts_outcome?.flatMap((r) => r.outcome.logs) ?? [],
  };
  save("gate-d-15-request-signature.json", out.steps.request_signature);

  const fullTx = signTx
    ? await nearRpc("EXPERIMENTAL_tx_status", [signTx, agentId])
    : null;
  if (fullTx) save("gate-d-16-full-tx.json", fullTx);
  const extracted = extractSig(fullTx);
  out.steps.signature_extraction = extracted;
  save("gate-d-17-signature.json", extracted);

  if (!extracted.found) {
    out.verdicts.D_mpc_sign = {
      status: "FAIL",
      reason: "no MPC signature in receipts",
      error: signErr,
    };
    save("gate-d-evidence.json", out);
    throw new Error("MPC signature missing");
  }

  const { r, s, recoveryId } = mpcToRsV(extracted.signature_json);
  let recovered = recoverFromTxHash(digest, r, s, recoveryId);
  let usedRecovery = recoveryId;
  if (recovered.toLowerCase() !== EVM) {
    const alt = recoveryId ^ 1;
    const altAddr = recoverFromTxHash(digest, r, s, alt);
    if (altAddr.toLowerCase() === EVM) {
      recovered = altAddr;
      usedRecovery = alt;
    }
  }
  out.steps.sig_recover = {
    recovered,
    matches: recovered.toLowerCase() === EVM,
    recovery_id_used: usedRecovery,
  };
  save("gate-d-18-sig-recover.json", out.steps.sig_recover);
  out.verdicts.D_mpc_sign = {
    status: recovered.toLowerCase() === EVM ? "PASS" : "FAIL",
    recovered,
  };
  if (recovered.toLowerCase() !== EVM) {
    save("gate-d-evidence.json", out);
    throw new Error(`recovered ${recovered} != ${EVM}`);
  }

  const rawTx = serializeSignedTx({
    ...txFields,
    r,
    s,
    recoveryId: usedRecovery,
  });
  out.steps.signed_raw_tx = rawTx.slice(0, 20) + "…" + rawTx.slice(-20);
  const send = await eth("eth_sendRawTransaction", [rawTx]);
  out.steps.broadcast = { result: send.result, error: send.error || null, raw_len: rawTx.length };
  save("gate-d-19-broadcast.json", out.steps.broadcast);
  if (!send.result) {
    out.verdicts.D_funded_transfer = {
      status: "FAIL",
      reason: send.error?.message || "broadcast failed",
    };
    save("gate-d-evidence.json", out);
    throw new Error("broadcast failed: " + JSON.stringify(send.error));
  }
  const sepoliaTxHash = send.result;
  // Wait for receipt; first attempt OOG'd at gasLimit=100k (status 0x0).
  let receipt = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const rr = await eth("eth_getTransactionReceipt", [sepoliaTxHash]);
    if (rr.result) {
      receipt = rr.result;
      break;
    }
  }
  out.steps.sepolia_receipt = {
    status: receipt?.status || null,
    gasUsed: receipt?.gasUsed || null,
    logs: receipt?.logs?.length ?? 0,
  };
  save("gate-d-19b-receipt.json", out.steps.sepolia_receipt);
  const minedOk = receipt?.status === "0x1";
  out.verdicts.D_funded_transfer = {
    status: minedOk ? "PASS" : "FAIL",
    sepolia_tx: sepoliaTxHash,
    depositAddress,
    amount: AMOUNT,
    receipt_status: receipt?.status || null,
    note: minedOk
      ? "ERC20 transfer mined successfully"
      : "Broadcast mined but execution reverted (check gas)",
  };
  if (!minedOk) {
    save("gate-d-evidence.json", out);
    throw new Error(
      `Sepolia tx reverted status=${receipt?.status} gasUsed=${receipt?.gasUsed}`
    );
  }

  // Optional deposit notify
  try {
    const notify = await fetch(`${TIDEPOOL}/v0/deposit/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txHash: sepoliaTxHash, depositAddress }),
    });
    out.steps.deposit_notify = {
      status: notify.status,
      body: await notify.json().catch(() => null),
    };
  } catch (e) {
    out.steps.deposit_notify = { error: String(e) };
  }

  // ── Poll status ───────────────────────────────────────────────────────
  const statuses = [];
  let terminal = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    const st = await fetch(
      `${TIDEPOOL}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`
    );
    const body = await st.json();
    const status = body?.status || body?.swapDetails?.status || body;
    statuses.push({ at: new Date().toISOString(), http: st.status, status, body });
    console.log("status poll", i, JSON.stringify(status));
    const s = typeof status === "string" ? status : status?.status || "";
    if (
      /SUCCESS|COMPLETED|REFUNDED|FAILED|EXPIRED|INACTIVE/i.test(s) ||
      body?.status === "SUCCESS" ||
      body?.status === "REFUNDED" ||
      body?.status === "FAILED"
    ) {
      terminal = body;
      break;
    }
  }
  out.steps.status_poll = { samples: statuses.slice(-5), terminal, count: statuses.length };
  save("gate-d-20-status.json", out.steps.status_poll);

  const usdcAfter = await erc20Balance(USDC_SEPOLIA, EVM);
  const intentsWnear = await viewFunction(
    "verifier.tidepool-sandbox.testnet",
    "mt_balance_of",
    { account_id: EVM, token_id: DEST_ASSET }
  ).catch((e) => String(e));
  out.steps.balances_after = {
    sepolia_usdc: usdcAfter.toString(),
    sepolia_usdc_delta: (usdcBal - usdcAfter).toString(),
    intents_wnear: intentsWnear,
  };
  save("gate-d-21-balances-after.json", out.steps.balances_after);

  const success =
    terminal?.status === "SUCCESS" ||
    /SUCCESS/i.test(JSON.stringify(terminal || {}));
  out.verdicts.D_swap_settle = {
    status: success ? "PASS" : terminal ? "FAIL" : "BLOCKED",
    terminal_status: terminal?.status || null,
    sepolia_tx: sepoliaTxHash,
  };

  // Mark settlement on policy
  try {
    const ms = await owner.functionCall({
      contractId,
      methodName: "mark_settlement",
      args: {
        operation_id: opId,
        settlement_state: success ? "Success" : "Failed",
      },
      gas: BigInt("30000000000000"),
      attachedDeposit: 0n,
    });
    out.steps.mark_settlement = { ok: true, transaction_hash: ms.transaction.hash };
  } catch (e) {
    out.steps.mark_settlement = { ok: false, error: String(e) };
  }

  // ── Revoke race: second trade after revoke must fail ──────────────────
  const revoke = await owner.functionCall({
    contractId,
    methodName: "revoke",
    args: {},
    gas: BigInt("30000000000000"),
    attachedDeposit: 0n,
  });
  out.steps.revoke = { transaction_hash: revoke.transaction.hash };
  let postRevokeOk = false;
  let postRevokeErr = null;
  try {
    await agent.functionCall({
      contractId,
      methodName: "propose_trade",
      args: {
        proposal: {
          operation_id: `gated-post-revoke-${Date.now()}`,
          amount_in: AMOUNT,
          asset_in: ORIGIN_ASSET,
          asset_out: DEST_ASSET,
          destination: depositAddress,
          min_amount_out: quoteBody.quote.minAmountOut,
          intent_deadline: intentDeadlineNs,
          payload_commitment: "22".repeat(32),
        },
      },
      gas: BigInt("50000000000000"),
      attachedDeposit: 0n,
    });
    postRevokeOk = true;
  } catch (e) {
    postRevokeErr = String(e);
  }
  out.steps.revoke_race = {
    post_revoke_propose_accepted: postRevokeOk,
    error: postRevokeErr,
  };
  out.verdicts.D_revoke_race = {
    status: !postRevokeOk ? "PASS" : "FAIL",
  };
  save("gate-d-22-revoke-race.json", out.steps.revoke_race);

  out.finished_at = new Date().toISOString();
  save("gate-d-evidence.json", out);
  console.log(JSON.stringify(out.verdicts, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
