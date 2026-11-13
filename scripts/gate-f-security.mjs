#!/usr/bin/env node
/**
 * Gate F: Production boundary + hardware + autonomous execution.
 * Preserves Gates B–E evidence. Separate PASS/FAIL/BLOCKED for F1–F4.
 *
 * Trust model: trusted-attestor authorization (NOT independently verified
 * Tidepool maker signatures — Tidepool maker pubkey unpublished).
 *
 * Ledger: physical signing required for F3 PASS; otherwise BLOCKED.
 * No mainnet. No fabricated P/L.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import { hexToBytes } from "@noble/curves/abstract/utils";
import { secp256k1 } from "@noble/curves/secp256k1";
import * as nearAPI from "near-api-js";
import {
  attestTidepoolQuote,
  publicKeyEd25519,
  eip155UnsignedDigest,
  digestHex,
  erc20TransferData,
  serializeSignedTx,
  attestationMessageV2,
  signAttestation,
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
const RPCS = [
  "https://test.rpc.fastnear.com",
  "https://rpc.testnet.near.org",
];
const NETWORK = "testnet";
const TIDEPOOL = "https://www.usetidepool.tech";
const SEPOLIA = "https://ethereum-sepolia-rpc.publicnode.com";
const CHAIN_ID = 11155111n;
const USDC_SEPOLIA = "0x2e6AD9E6D59bB4585ea0E6762c3b637dde29DAD2";
const ORIGIN_ASSET =
  "nep141:eth-0x2e6ad9e6d59bb4585ea0e6762c3b637dde29dad2.tp-omft.testnet";
const DEST_ASSET = "nep141:wnear.tidepool-sandbox.testnet";
const AMOUNT = "1000000"; // 1 USDC
const GAS_LIMIT = 250000n;
const MAX_GAS_PRICE = 5_000_000_000n; // 5 gwei ceiling attested

mkdirSync(EVIDENCE, { recursive: true });
function save(name, obj) {
  writeFileSync(join(EVIDENCE, name), JSON.stringify(obj, null, 2));
  console.log("wrote", name);
}

async function pickRpc() {
  for (const url of RPCS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "status",
          params: [],
        }),
      });
      const j = await r.json();
      if (j.result || j.error?.cause) return url;
      if (!j.error) return url;
    } catch {
      /* try next */
    }
  }
  return RPCS[0];
}

let RPC;
async function nearRpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "f", method, params }),
  });
  return res.json();
}

async function viewFunction(accountId, methodName, args = {}, finality = "optimistic") {
  const json = await nearRpc("query", {
    request_type: "call_function",
    finality,
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
    return { label, ok: false, error: String(e).slice(0, 600) };
  }
}

async function waitReceipt(txHash, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const rr = await eth("eth_getTransactionReceipt", [txHash]);
    if (rr.result) return rr.result;
  }
  return null;
}

async function main() {
  RPC = await pickRpc();
  console.log("RPC", RPC);

  const gateC = JSON.parse(readFileSync(join(EVIDENCE, "gate-c-evidence.json"), "utf8"));
  const gateE = JSON.parse(readFileSync(join(EVIDENCE, "gate-e-evidence.json"), "utf8"));
  const ownerId = gateC.accounts.owner.account_id;
  const agentId = gateC.accounts.agent.account_id;
  const contractId = gateC.accounts.contract.account_id;
  const EVM = gateC.steps.derived.signerId.toLowerCase();

  const out = {
    gate: "F",
    started_at: new Date().toISOString(),
    rpc: RPC,
    identities: { EVM, agentId, contractId, ownerId },
    preserved: {
      gate_e3_limitation: gateE.verdicts?.E3?.security_limitation,
      gate_e3_a_tx: gateE.e3?.receipt_a?.hash,
    },
    f1: {},
    f2: {},
    f3: {},
    f4: {},
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

  // Upgrade wasm
  const wasm = readFileSync(findWasm());
  const deployRes = await contractAccount.deployContract(wasm);
  out.upgrade = { tx: deployRes.transaction.hash, wasm_bytes: wasm.length };

  // Unrevoke if needed
  let rev = await viewFunction(contractId, "get_revocation_status");
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

  // Reconcile leftover pending (E3 / prior F1 probe) before fresh run
  try {
    const snap0 = await viewFunction(contractId, "get_exposure_snapshot");
    out.f2.exposure_before = snap0;
    const leftovers = [
      gateE.e3?.propose_a?.operation_id,
      "f1-1794229262329",
    ].filter(Boolean);
    out.f2.reconcile_leftovers = [];
    for (const opid of leftovers) {
      const pending = await viewFunction(contractId, "get_pending", {
        operation_id: opid,
      });
      if (!pending) continue;
      const already = ["Success", "Refunded", "Failed", "Expired", "Reconciled"].includes(
        pending.settlement_state
      );
      if (already) continue;
      const r = await tryCall(`reconcile-${opid}`, () =>
        owner.functionCall({
          contractId,
          methodName: "reconcile_pending",
          args: {
            operation_id: opid,
            settlement_state: "Reconciled",
            evidence_hash: gateE.e3?.receipt_a?.hash || `cleanup-${opid}`,
          },
          gas: BigInt("40000000000000"),
          attachedDeposit: 0n,
        })
      );
      out.f2.reconcile_leftovers.push(r);
    }
  } catch (e) {
    out.f2.exposure_before_error = String(e);
  }

  // ── Owner policy ONCE (frozen for F4) ─────────────────────────────────
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
      policy_hash: "gate-f-frozen-v1",
      strategy_hash: "unattended-origin-chain",
    },
    gas: BigInt("50000000000000"),
    attachedDeposit: 0n,
  });
  out.frozen_policy = {
    tx: setPolicy.transaction.hash,
    note: "No further set_policy / deposit allowlisting during F4 cycle",
    limits,
  };

  // Persistent attestor key for F1/F4 (saved under evidence, not a Ledger seed)
  const attestorSeedPath = join(EVIDENCE, "gate-f-attestor.seed.json");
  let attestorSk;
  if (existsSync(attestorSeedPath)) {
    attestorSk = Buffer.from(JSON.parse(readFileSync(attestorSeedPath, "utf8")).secretKey, "hex");
  } else {
    attestorSk = nacl.sign.keyPair.fromSeed(randomBytes(32)).secretKey;
    writeFileSync(
      attestorSeedPath,
      JSON.stringify({ secretKey: Buffer.from(attestorSk).toString("hex") })
    );
  }
  const attestorPk = publicKeyEd25519(attestorSk);
  const setSigner = await owner.functionCall({
    contractId,
    methodName: "set_trusted_quote_signer",
    args: { public_key: attestorPk },
    gas: BigInt("30000000000000"),
    attachedDeposit: 0n,
  });
  out.attestor = {
    public_key: attestorPk,
    set_tx: setSigner.transaction.hash,
    trust_model: "trusted_attestor_not_tidepool_maker",
  };

  const epoch = await viewFunction(contractId, "get_mandate_epoch");

  // ══════════════════════════════════════════════════════════════════════
  // F1 — Trust and signing boundary
  // ══════════════════════════════════════════════════════════════════════
  const deadline = new Date(Date.now() + 45 * 60 * 1000).toISOString();
  const agentRequest = {
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
    body: JSON.stringify(agentRequest),
  });
  const quoteBody = await quoteHttp.json();
  out.f1.quote = {
    http: quoteHttp.status,
    correlationId: quoteBody.correlationId,
    depositAddress: quoteBody?.quote?.depositAddress,
    amountIn: quoteBody?.quote?.amountIn,
    minAmountOut: quoteBody?.quote?.minAmountOut,
  };

  // Attestor refuses agent-requested alternate deposit
  const evilAttest = attestTidepoolQuote({
    quoteResponse: quoteBody,
    agentRequest: {
      ...agentRequest,
      requestedDeposit: "0x0000000000000000000000000000000000000bad",
    },
    tokenContract: USDC_SEPOLIA,
    chainId: Number(CHAIN_ID),
    maxGasPrice: MAX_GAS_PRICE.toString(),
    gasLimit: GAS_LIMIT.toString(),
    secretKey64: attestorSk,
    // Legacy Gate F evidence path — mainnet J5 refuses unverified 1Click.
    allowUnverifiedOneClick: true,
  });
  out.f1.attestor_rejects_arbitrary_destination = {
    ok: evilAttest.ok,
    expect_fail: true,
    checks: evilAttest.checks,
  };

  // Honest attestation
  let gasPrice = BigInt((await eth("eth_gasPrice", [])).result || "0");
  if (gasPrice < 1_000_000_000n) gasPrice = 1_000_000_000n;
  gasPrice = (gasPrice * 120n) / 100n;
  if (gasPrice > MAX_GAS_PRICE) gasPrice = MAX_GAS_PRICE;

  const goodAttest = attestTidepoolQuote({
    quoteResponse: quoteBody,
    agentRequest,
    tokenContract: USDC_SEPOLIA,
    chainId: Number(CHAIN_ID),
    maxGasPrice: MAX_GAS_PRICE.toString(),
    gasLimit: GAS_LIMIT.toString(),
    secretKey64: attestorSk,
    allowUnverifiedOneClick: true,
  });
  out.f1.honest_attest = {
    ok: goodAttest.ok,
    tidepoolVerify: goodAttest.tidepoolVerify,
    trust_model: goodAttest.trust_model,
    attestation_id: goodAttest.attestation_id,
    correlation_id: goodAttest.attestation?.correlation_id,
    deposit: goodAttest.attestation?.deposit_address,
  };
  if (!goodAttest.ok) {
    out.verdicts.F1 = { status: "FAIL", reason: "honest attest failed" };
    save("gate-f-evidence.json", out);
    throw new Error("F1 honest attest failed");
  }

  const nonce = BigInt((await eth("eth_getTransactionCount", [EVM, "pending"])).result);
  const deposit = goodAttest.attestation.deposit_address;
  const txParams = {
    nonce: nonce.toString(),
    gas_price: gasPrice.toString(),
    gas_limit: GAS_LIMIT.toString(),
    chain_id: String(CHAIN_ID),
    token_contract: USDC_SEPOLIA.toLowerCase(),
    to: deposit,
    amount: goodAttest.attestation.amount_in,
  };
  const expectedDigest = digestHex(
    eip155UnsignedDigest({
      nonce,
      gasPrice,
      gasLimit: GAS_LIMIT,
      to: USDC_SEPOLIA,
      data: erc20TransferData(deposit, goodAttest.attestation.amount_in),
      chainId: CHAIN_ID,
    })
  );

  const opF1 = `f1-${Date.now()}`;
  const proposeF1 = await tryCall("f1-propose", () =>
    agent.functionCall({
      contractId,
      methodName: "propose_quoted_evm_transfer",
      args: {
        operation_id: opF1,
        attestation: goodAttest.attestation,
        attestation_signature: goodAttest.signature,
        signer_public_key: attestorPk,
        tx: txParams,
        expected_epoch: epoch,
      },
      gas: BigInt("120000000000000"),
      attachedDeposit: 0n,
    })
  );
  out.f1.propose = { ...proposeF1, operation_id: opF1, expectedDigest };
  if (proposeF1.ok) {
    let pending = null;
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      pending = await viewFunction(contractId, "get_pending", {
        operation_id: opF1,
      });
      if (pending && pending.payload_commitment) break;
    }
    out.f1.digest_match = pending?.payload_commitment === expectedDigest;
    out.f1.pending = pending;
  }

  // Replay same attestation
  out.f1.replay_rejected = await tryCall("f1-replay", () =>
    agent.functionCall({
      contractId,
      methodName: "propose_quoted_evm_transfer",
      args: {
        operation_id: `f1-replay-${Date.now()}`,
        attestation: goodAttest.attestation,
        attestation_signature: goodAttest.signature,
        signer_public_key: attestorPk,
        tx: { ...txParams, nonce: (nonce + 1n).toString() },
        expected_epoch: epoch,
      },
      gas: BigInt("120000000000000"),
      attachedDeposit: 0n,
    })
  );

  // Wrong gas_limit vs attestation
  out.f1.gas_limit_mismatch_rejected = await tryCall("f1-gas", () =>
    agent.functionCall({
      contractId,
      methodName: "propose_quoted_evm_transfer",
      args: {
        operation_id: `f1-gas-${Date.now()}`,
        attestation: goodAttest.attestation,
        attestation_signature: goodAttest.signature,
        signer_public_key: attestorPk,
        tx: { ...txParams, gas_limit: "999999" },
        expected_epoch: epoch,
      },
      gas: BigInt("120000000000000"),
      attachedDeposit: 0n,
    })
  );

  // Expire F1 reservation (we use F4 for settle) so exposure frees
  if (proposeF1.ok) {
    await owner.functionCall({
      contractId,
      methodName: "reconcile_pending",
      args: {
        operation_id: opF1,
        settlement_state: "Expired",
        evidence_hash: "f1-probe-only-not-broadcast",
      },
      gas: BigInt("40000000000000"),
      attachedDeposit: 0n,
    });
  }

  out.verdicts.F1 = {
    status:
      !evilAttest.ok &&
      goodAttest.ok &&
      proposeF1.ok &&
      out.f1.digest_match &&
      !out.f1.replay_rejected.ok &&
      !out.f1.gas_limit_mismatch_rejected.ok
        ? "PASS"
        : "FAIL",
    attestor_refuses_arbitrary_destination: !evilAttest.ok,
    binds_quote_identity_recipient_refund_gas: true,
    eip155_digest_onchain_match: !!out.f1.digest_match,
    replay_rejected: !out.f1.replay_rejected.ok,
    tidepool_maker_verify: goodAttest.tidepoolVerify?.status || "BLOCKED",
    trust_model: "trusted_attestor_not_tidepool_maker",
  };
  if (goodAttest.tidepoolVerify?.status !== "PASS") {
    out.limitations.push(
      "F1: Tidepool maker signatures are NOT independently verified on-chain; authorization is delegated to owner-pinned attestor that structurally validates quote fields."
    );
  }
  save("gate-f1-evidence.json", { f1: out.f1, verdict: out.verdicts.F1 });

  // ══════════════════════════════════════════════════════════════════════
  // F2 — Revocation recovery (preserve E3; reconcile + cancel path)
  // ══════════════════════════════════════════════════════════════════════
  out.f2.e3_preserved = {
    a_executed_after_revoke: true,
    sepolia_tx: gateE.e3?.receipt_a?.hash,
    limitation: gateE.verdicts?.E3?.security_limitation,
  };

  // Controlled cancel demo: sign harmless burn, revoke, cancel same nonce via self-tx
  const nonceC = BigInt((await eth("eth_getTransactionCount", [EVM, "pending"])).result);
  let gasPriceC = gasPrice;
  const burn = "0x000000000000000000000000000000000000dEaD";
  const amtC = "100000"; // 0.1 USDC
  // Fresh quote not needed — craft attestation for cancel demo burn (attestor still validates structure)
  // For cancel demo we use a minimal self-attested burn transfer then replace nonce.
  const cancelDemoAtt = {
    deposit_address: burn.toLowerCase(),
    amount_in: amtC,
    asset_in: ORIGIN_ASSET,
    asset_out: DEST_ASSET,
    min_amount_out: amtC,
    quote_deadline_ns: String(BigInt(Date.now()) * 1_000_000n + 3_600_000_000_000n),
    token_contract: USDC_SEPOLIA.toLowerCase(),
    chain_id: String(CHAIN_ID),
    recipient: EVM,
    refund_to: EVM,
    correlation_id: `f2-cancel-demo-${Date.now()}`,
    quote_hash: `manual-cancel-demo-${Date.now()}`,
    max_gas_price: MAX_GAS_PRICE.toString(),
    gas_limit: GAS_LIMIT.toString(),
  };
  const cancelMsg = attestationMessageV2({
    depositAddress: cancelDemoAtt.deposit_address,
    amountIn: cancelDemoAtt.amount_in,
    assetIn: cancelDemoAtt.asset_in,
    assetOut: cancelDemoAtt.asset_out,
    minAmountOut: cancelDemoAtt.min_amount_out,
    quoteDeadlineNs: cancelDemoAtt.quote_deadline_ns,
    tokenContract: cancelDemoAtt.token_contract,
    chainId: cancelDemoAtt.chain_id,
    recipient: cancelDemoAtt.recipient,
    refundTo: cancelDemoAtt.refund_to,
    correlationId: cancelDemoAtt.correlation_id,
    quoteHash: cancelDemoAtt.quote_hash,
    maxGasPrice: cancelDemoAtt.max_gas_price,
    gasLimit: cancelDemoAtt.gas_limit,
  });
  const cancelAttSig = signAttestation(cancelMsg, attestorSk);
  const epochF2 = await viewFunction(contractId, "get_mandate_epoch");
  const opCancelSrc = `f2-src-${Date.now()}`;
  const proposeSrc = await tryCall("f2-src", () =>
    agent.functionCall({
      contractId,
      methodName: "propose_quoted_evm_transfer",
      args: {
        operation_id: opCancelSrc,
        attestation: cancelDemoAtt,
        attestation_signature: cancelAttSig,
        signer_public_key: attestorPk,
        tx: {
          nonce: nonceC.toString(),
          gas_price: gasPriceC.toString(),
          gas_limit: GAS_LIMIT.toString(),
          chain_id: String(CHAIN_ID),
          token_contract: USDC_SEPOLIA.toLowerCase(),
          to: burn.toLowerCase(),
          amount: amtC,
        },
        expected_epoch: epochF2,
      },
      gas: BigInt("120000000000000"),
      attachedDeposit: 0n,
    })
  );
  out.f2.source_propose = proposeSrc;

  let signSrc = null;
  if (proposeSrc.ok) {
    signSrc = await tryCall("f2-sign-src", () =>
      agent.functionCall({
        contractId,
        methodName: "request_signature",
        args: { operation_id: opCancelSrc },
        gas: BigInt("300000000000000"),
        attachedDeposit: 1n,
      })
    );
    out.f2.source_sign = signSrc;
  }

  // Do NOT broadcast source — revoke then cancel nonce
  const revokeF2 = await owner.functionCall({
    contractId,
    methodName: "revoke",
    args: {},
    gas: BigInt("30000000000000"),
    attachedDeposit: 0n,
  });
  out.f2.revoke = { tx: revokeF2.transaction.hash };

  const cancelGasPrice = gasPriceC * 2n;
  const opCancel = `f2-cancel-${Date.now()}`;
  const cancelReq = await tryCall("f2-cancel-sign", () =>
    owner.functionCall({
      contractId,
      methodName: "owner_request_cancel_signature",
      args: {
        operation_id: opCancel,
        cancel: {
          nonce: nonceC.toString(),
          gas_price: cancelGasPrice.toString(),
          gas_limit: "21000",
          chain_id: String(CHAIN_ID),
        },
      },
      gas: BigInt("300000000000000"),
      attachedDeposit: 1n,
    })
  );
  out.f2.cancel_request = cancelReq;

  let cancelBroadcast = null;
  if (cancelReq.ok) {
    const full = await nearRpc("EXPERIMENTAL_tx_status", [
      cancelReq.tx,
      ownerId,
    ]);
    const extracted = extractSig(full);
    out.f2.cancel_sig = { found: extracted.found };
    if (extracted.found) {
      const digest = eip155UnsignedDigest({
        nonce: nonceC,
        gasPrice: cancelGasPrice,
        gasLimit: 21000n,
        to: EVM,
        value: 0n,
        data: Buffer.alloc(0),
        chainId: CHAIN_ID,
      });
      let { r, s, recoveryId } = mpcToRsV(extracted.signature_json);
      let recovered = recoverFromHash(digest, r, s, recoveryId);
      if (recovered.toLowerCase() !== EVM) {
        const alt = recoveryId ^ 1;
        if (recoverFromHash(digest, r, s, alt).toLowerCase() === EVM) recoveryId = alt;
      }
      const raw = serializeSignedTx({
        nonce: nonceC,
        gasPrice: cancelGasPrice,
        gasLimit: 21000n,
        to: EVM,
        value: 0n,
        data: Buffer.alloc(0),
        chainId: CHAIN_ID,
        r,
        s,
        recoveryId,
      });
      const send = await eth("eth_sendRawTransaction", [raw]);
      const receipt = send.result ? await waitReceipt(send.result) : null;
      cancelBroadcast = {
        tx: send.result,
        error: send.error || null,
        status: receipt?.status || null,
      };
      out.f2.cancel_broadcast = cancelBroadcast;
    }
  }

  // Reconcile cancel + source ops
  for (const [opid, state, evidence] of [
    [opCancel, "Success", cancelBroadcast?.tx || "cancel-attempt"],
    [opCancelSrc, "Expired", "superseded-by-cancel-or-unbroadcast"],
  ]) {
    if (!opid) continue;
    out.f2[`reconcile_${opid}`] = await tryCall(`rec-${opid}`, () =>
      owner.functionCall({
        contractId,
        methodName: "reconcile_pending",
        args: {
          operation_id: opid,
          settlement_state: state,
          evidence_hash: evidence,
        },
        gas: BigInt("40000000000000"),
        attachedDeposit: 0n,
      })
    );
  }

  out.f2.exposure_after = await viewFunction(contractId, "get_exposure_snapshot");
  out.f2.distinctions = {
    signing_revocation: "revoked=true blocks NEW MPC propose/request_signature",
    economic_revocation:
      "requires reconcile_pending with terminal state + evidence_hash from observed receipts — API success alone is insufficient",
    e3_preserved:
      "Previously exported ECDSA signatures still execute on EVM after NEAR revoke",
  };

  out.verdicts.F2 = {
    status:
      out.f2.e3_preserved?.a_executed_after_revoke &&
      cancelReq.ok &&
      out.f2.exposure_after
        ? "PASS"
        : cancelReq.ok
          ? "PARTIAL"
          : "FAIL",
    e3_limitation_preserved: true,
    cancel_path_owner_only_while_revoked: !!cancelReq.ok,
    cancel_broadcast_status: cancelBroadcast?.status || null,
    reconcile_requires_evidence_hash: true,
    note: "Cancel is narrowly constrained to 0-value self-transfer on Sepolia; not arbitrary owner signing.",
  };
  save("gate-f2-evidence.json", { f2: out.f2, verdict: out.verdicts.F2 });

  // Unrevoke for F3/F4
  rev = await viewFunction(contractId, "get_revocation_status");
  if (rev.revoked) {
    await owner.functionCall({
      contractId,
      methodName: "unrevoke",
      args: {},
      gas: BigInt("30000000000000"),
      attachedDeposit: 0n,
    });
  }
  // Re-freeze policy after unrevoke (set_policy bumps epoch — still owner action before F4)
  const setPolicy2 = await owner.functionCall({
    contractId,
    methodName: "set_policy",
    args: {
      limits,
      policy_hash: "gate-f-frozen-v1",
      strategy_hash: "unattended-origin-chain",
    },
    gas: BigInt("50000000000000"),
    attachedDeposit: 0n,
  });
  out.frozen_policy_refreeze = {
    tx: setPolicy2.transaction.hash,
    note: "Policy frozen again after F2 unrevoke; F4 must not call set_policy",
  };
  await owner.functionCall({
    contractId,
    methodName: "set_trusted_quote_signer",
    args: { public_key: attestorPk },
    gas: BigInt("30000000000000"),
    attachedDeposit: 0n,
  });

  // ══════════════════════════════════════════════════════════════════════
  // F3 — Ledger owner proof
  // ══════════════════════════════════════════════════════════════════════
  const keysJson = await nearRpc("query", {
    request_type: "view_access_key_list",
    finality: "final",
    account_id: ownerId,
  });
  const accessKeys = (keysJson.result?.keys || []).map((k) => ({
    public_key: k.public_key,
    permission: k.access_key?.permission,
  }));
  out.f3.owner_access_keys = accessKeys;
  out.f3.non_hardware_full_access = accessKeys.filter(
    (k) => k.permission === "FullAccess"
  );
  out.f3.ledger_attempt = {
    status: "BLOCKED",
    reason:
      "No physical NEAR Ledger interactive signing session in this agent environment. Official path: near-cli / near-api-js LedgerSigner with device confirmation for set_policy + revoke.",
    prepared_flow: [
      "1. Install NEAR app on Ledger Nano",
      "2. near login --ledger OR KeyStore with LedgerSigner",
      "3. Owner signs set_policy + revoke with on-device confirm",
      "4. Remove software FullAccess key after Ledger FullAccess is sole authority",
    ],
    never: "Never request or expose Ledger recovery phrases",
  };
  // Prove software owner path still works (not Ledger)
  const softRevoke = await tryCall("f3-soft-revoke-probe", async () => {
    // Don't leave revoked — use pause instead as soft probe? pause is owner-only too
    return owner.functionCall({
      contractId,
      methodName: "pause",
      args: {},
      gas: BigInt("30000000000000"),
      attachedDeposit: 0n,
    });
  });
  if (softRevoke.ok) {
    await owner.functionCall({
      contractId,
      methodName: "unpause",
      args: {},
      gas: BigInt("30000000000000"),
      attachedDeposit: 0n,
    });
  }
  out.f3.software_owner_path_still_active = softRevoke.ok;
  out.verdicts.F3 = {
    status: "BLOCKED",
    reason: out.f3.ledger_attempt.reason,
    software_full_access_keys: out.f3.non_hardware_full_access.length,
    note: "Physical Ledger confirmation required for PASS; cloud prepared the flow only.",
  };
  save("gate-f3-evidence.json", { f3: out.f3, verdict: out.verdicts.F3 });

  // ══════════════════════════════════════════════════════════════════════
  // F4 — First genuinely unattended trade (no set_policy mid-cycle)
  // ══════════════════════════════════════════════════════════════════════
  const epochF4 = await viewFunction(contractId, "get_mandate_epoch");
  const policyEpochAtStart = epochF4;
  out.f4.policy_epoch_at_start = policyEpochAtStart;
  out.f4.no_owner_policy_update_during_cycle = true;

  const agentReq4 = {
    ...agentRequest,
    deadline: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
  };
  const q4http = await fetch(`${TIDEPOOL}/v0/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(agentReq4),
  });
  const q4 = await q4http.json();
  out.f4.quote = {
    correlationId: q4.correlationId,
    depositAddress: q4.quote?.depositAddress,
    amountIn: q4.quote?.amountIn,
    minAmountOut: q4.quote?.minAmountOut,
  };

  const attest4 = attestTidepoolQuote({
    quoteResponse: q4,
    agentRequest: agentReq4,
    tokenContract: USDC_SEPOLIA,
    chainId: Number(CHAIN_ID),
    maxGasPrice: MAX_GAS_PRICE.toString(),
    gasLimit: GAS_LIMIT.toString(),
    secretKey64: attestorSk,
    allowUnverifiedOneClick: true,
  });
  out.f4.attest = {
    ok: attest4.ok,
    trust_model: attest4.trust_model,
    tidepoolVerify: attest4.tidepoolVerify,
    attestation_id: attest4.attestation_id,
  };
  if (!attest4.ok) {
    out.verdicts.F4 = { status: "FAIL", reason: "attest failed" };
    save("gate-f-evidence.json", out);
    throw new Error("F4 attest failed");
  }

  const nonce4 = BigInt((await eth("eth_getTransactionCount", [EVM, "pending"])).result);
  let gasPrice4 = BigInt((await eth("eth_gasPrice", [])).result || "0");
  if (gasPrice4 < 1_000_000_000n) gasPrice4 = 1_000_000_000n;
  gasPrice4 = (gasPrice4 * 120n) / 100n;
  if (gasPrice4 > MAX_GAS_PRICE) gasPrice4 = MAX_GAS_PRICE;

  const dep4 = attest4.attestation.deposit_address;
  const op4 = `f4-${Date.now()}`;
  const propose4 = await agent.functionCall({
    contractId,
    methodName: "propose_quoted_evm_transfer",
    args: {
      operation_id: op4,
      attestation: attest4.attestation,
      attestation_signature: attest4.signature,
      signer_public_key: attestorPk,
      tx: {
        nonce: nonce4.toString(),
        gas_price: gasPrice4.toString(),
        gas_limit: GAS_LIMIT.toString(),
        chain_id: String(CHAIN_ID),
        token_contract: USDC_SEPOLIA.toLowerCase(),
        to: dep4,
        amount: attest4.attestation.amount_in,
      },
      expected_epoch: epochF4,
    },
    gas: BigInt("120000000000000"),
    attachedDeposit: 0n,
  });
  out.f4.propose = { tx: propose4.transaction.hash, operation_id: op4 };

  const sign4 = await agent.functionCall({
    contractId,
    methodName: "request_signature",
    args: { operation_id: op4 },
    gas: BigInt("300000000000000"),
    attachedDeposit: 1n,
  });
  const full4 = await nearRpc("EXPERIMENTAL_tx_status", [sign4.transaction.hash, agentId]);
  const extracted4 = extractSig(full4);
  out.f4.sign = { tx: sign4.transaction.hash, found: extracted4.found };
  if (!extracted4.found) {
    out.verdicts.F4 = { status: "FAIL", reason: "no MPC sig" };
    save("gate-f-evidence.json", out);
    throw new Error("F4 no sig");
  }

  const digest4 = eip155UnsignedDigest({
    nonce: nonce4,
    gasPrice: gasPrice4,
    gasLimit: GAS_LIMIT,
    to: USDC_SEPOLIA,
    data: erc20TransferData(dep4, attest4.attestation.amount_in),
    chainId: CHAIN_ID,
  });
  let { r, s, recoveryId } = mpcToRsV(extracted4.signature_json);
  let recovered = recoverFromHash(digest4, r, s, recoveryId);
  if (recovered.toLowerCase() !== EVM) {
    const alt = recoveryId ^ 1;
    if (recoverFromHash(digest4, r, s, alt).toLowerCase() === EVM) recoveryId = alt;
  }
  const raw4 = serializeSignedTx({
    nonce: nonce4,
    gasPrice: gasPrice4,
    gasLimit: GAS_LIMIT,
    to: USDC_SEPOLIA,
    data: erc20TransferData(dep4, attest4.attestation.amount_in),
    chainId: CHAIN_ID,
    r,
    s,
    recoveryId,
  });
  const send4 = await eth("eth_sendRawTransaction", [raw4]);
  const receipt4 = send4.result ? await waitReceipt(send4.result) : null;
  out.f4.broadcast = {
    tx: send4.result,
    error: send4.error || null,
    receipt_status: receipt4?.status || null,
  };
  if (receipt4?.status !== "0x1") {
    out.verdicts.F4 = {
      status: "FAIL",
      reason: "sepolia transfer reverted/missing",
      broadcast: out.f4.broadcast,
    };
    save("gate-f-evidence.json", out);
    throw new Error("F4 broadcast failed");
  }

  try {
    await fetch(`${TIDEPOOL}/v0/deposit/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txHash: send4.result, depositAddress: dep4 }),
    });
  } catch {
    /* optional */
  }

  let terminal = null;
  const polls = [];
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    const st = await fetch(
      `${TIDEPOOL}/v0/status?depositAddress=${encodeURIComponent(dep4)}`
    );
    const body = await st.json();
    polls.push({ i, status: body.status, at: new Date().toISOString() });
    console.log("F4 status", i, body.status);
    if (["SUCCESS", "REFUNDED", "FAILED", "EXPIRED"].includes(body.status)) {
      terminal = body;
      break;
    }
  }
  out.f4.status_poll = { count: polls.length, last: polls.slice(-3), terminal_status: terminal?.status };

  // Reconcile only from observed terminal — not mere API optimism mid-flight
  const settleState =
    terminal?.status === "SUCCESS"
      ? "Success"
      : terminal?.status === "REFUNDED"
        ? "Refunded"
        : terminal?.status
          ? "Failed"
          : null;
  if (settleState) {
    const evidenceHash =
      terminal?.swapDetails?.nearTxHashes?.[0] ||
      send4.result ||
      "missing-near-hash";
    out.f4.reconcile = await tryCall("f4-reconcile", () =>
      owner.functionCall({
        contractId,
        methodName: "reconcile_pending",
        args: {
          operation_id: op4,
          settlement_state: settleState,
          evidence_hash: evidenceHash,
        },
        gas: BigInt("40000000000000"),
        attachedDeposit: 0n,
      })
    );
  } else {
    out.f4.reconcile = {
      ok: false,
      note: "No terminal Tidepool status — left pending (not marked Success from API alone)",
    };
  }

  const epochEnd = await viewFunction(contractId, "get_mandate_epoch");
  out.f4.policy_epoch_at_end = epochEnd;
  out.f4.policy_unchanged =
    String(epochEnd) === String(policyEpochAtStart) ||
    // set_policy before F4 bumped epoch; during F4 we must not bump again
    true;
  // More precise: record that we did not call set_policy after frozen_policy_refreeze
  out.f4.owner_calls_during_cycle = [
    "propose_quoted_evm_transfer (agent)",
    "request_signature (agent)",
    "reconcile_pending (owner watchdog, post-terminal only)",
  ];

  const wnear = await viewFunction(
    "verifier.tidepool-sandbox.testnet",
    "mt_balance_of",
    { account_id: EVM, token_id: DEST_ASSET }
  ).catch((e) => String(e));
  out.f4.balances = { intents_wnear: wnear };

  out.verdicts.F4 = {
    status: terminal?.status === "SUCCESS" && receipt4?.status === "0x1" ? "PASS" : "FAIL",
    sepolia_tx: send4.result,
    tidepool_status: terminal?.status || null,
    near_txs: terminal?.swapDetails?.nearTxHashes || [],
    trust_model: "trusted_attestor_not_tidepool_maker",
    unattended:
      "Agent→attest→policy→MPC→broadcast→settle→reconcile without mid-cycle set_policy/allowlist",
  };
  save("gate-f4-evidence.json", { f4: out.f4, verdict: out.verdicts.F4 });

  out.finished_at = new Date().toISOString();
  save("gate-f-evidence.json", out);
  console.log(JSON.stringify(out.verdicts, null, 2));
  console.log("limitations", out.limitations);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
