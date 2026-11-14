/**
 * J17.1 — contract ABI integration + error-path tests (no live broadcast).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import {
  expectedProposeQuotedEvmAbi,
  expectedRequestSignatureAbi,
  assertProposeQuotedArgs,
  assertRequestSignatureArgs,
  refuseProposeTradeEvmFallback,
  buildDeterministicErc20Attestation,
  bindEip155DigestFromQuotedTx,
  validateQuotedTxAgainstAttestation,
  fitGasLimit,
  verifyPolicyViews,
  requireJournalSecret,
  TEST_RECIPIENT,
  USDC_SEPOLIA,
  AMOUNT_RAW,
  CHAIN_ID,
  SCENARIO_LABEL,
} from "./j17.sepoliaPath.mjs";

describe("J17.1 contract ABI match", () => {
  it("request_signature ABI is operation_id only + 1 yocto", () => {
    const abi = expectedRequestSignatureAbi();
    assert.deepEqual(abi.args, ["operation_id"]);
    assert.equal(abi.deposit_yocto, "1");
    assert.equal(assertRequestSignatureArgs({ operation_id: "op1" }).ok, true);
    assert.equal(
      assertRequestSignatureArgs({ operation_id: "op1", path: "x" }).ok,
      false
    );
    assert.equal(
      assertRequestSignatureArgs({
        operation_id: "op1",
        payload: "deadbeef",
      }).ok,
      false
    );
  });

  it("propose_quoted_evm_transfer requires full attestation + tx + epoch", () => {
    const abi = expectedProposeQuotedEvmAbi();
    assert.ok(abi.args.includes("attestation"));
    assert.ok(abi.args.includes("attestation_signature"));
    assert.ok(abi.args.includes("signer_public_key"));
    assert.ok(abi.args.includes("tx"));
    assert.ok(abi.args.includes("expected_epoch"));
    assert.equal(assertProposeQuotedArgs({ operation_id: "x" }).ok, false);
  });

  it("refuses propose_trade fallback for 0x destinations", () => {
    const r = refuseProposeTradeEvmFallback({ destination: TEST_RECIPIENT });
    assert.equal(r.action, "REFUSE");
    assert.match(r.reason, /propose_quoted_evm_transfer/);
  });
});

describe("J17.1 digest binding + gas", () => {
  it("binds EIP-155 digest to token transfer(deposit, amount)", () => {
    const bind = bindEip155DigestFromQuotedTx({
      nonce: 0,
      gasPrice: "1000000000",
      gasLimit: "170000",
      tokenContract: USDC_SEPOLIA,
      depositAddress: TEST_RECIPIENT,
      amount: AMOUNT_RAW,
    });
    assert.equal(bind.digest_hex.length, 64);
    assert.equal(bind.eip155_to, USDC_SEPOLIA.toLowerCase());
    assert.equal(bind.transfer_to, TEST_RECIPIENT.toLowerCase());
    assert.ok(bind.data_hex.startsWith("0xa9059cbb"));
  });

  it("rejects tx/attestation mismatches", () => {
    const att = {
      deposit_address: TEST_RECIPIENT.toLowerCase(),
      token_contract: USDC_SEPOLIA.toLowerCase(),
      amount_in: AMOUNT_RAW,
      chain_id: String(CHAIN_ID),
      gas_limit: "170000",
      max_gas_price: "2000000000",
    };
    const bad = validateQuotedTxAgainstAttestation({
      attestation: att,
      tx: {
        to: "0x0000000000000000000000000000000000000001",
        token_contract: USDC_SEPOLIA.toLowerCase(),
        amount: AMOUNT_RAW,
        chain_id: String(CHAIN_ID),
        gas_limit: "170000",
        gas_price: "1000000000",
      },
    });
    assert.equal(bad.ok, false);
    assert.ok(bad.blockers.includes("tx.to_ne_attested_deposit"));
  });

  it("fits gas with headroom and policy budget", () => {
    const ok = fitGasLimit({
      estimated: 142000n,
      gasPrice: 1_000_000_000n,
      maxGasBudget: "500000000000000",
    });
    assert.equal(ok.ok, true);
    assert.ok(BigInt(ok.gas_limit) >= 142000n);
    const fail = fitGasLimit({
      estimated: 142000n,
      gasPrice: 50_000_000_000n,
      maxGasBudget: "500000000000000",
    });
    assert.equal(fail.ok, false);
  });

  it("deterministic attestation is labeled not-Intents", () => {
    const sk = Buffer.from(nacl.sign.keyPair().secretKey);
    const built = buildDeterministicErc20Attestation({
      secretKey64: sk,
      maxGasPrice: "1000000000",
      gasLimit: "170000",
    });
    assert.equal(built.ok, true);
    assert.equal(built.label, SCENARIO_LABEL);
    assert.equal(built.intents_settlement, false);
    assert.equal(built.attestation.deposit_address, TEST_RECIPIENT.toLowerCase());
    const tx = {
      nonce: "0",
      gas_price: "1000000000",
      gas_limit: "170000",
      chain_id: String(CHAIN_ID),
      token_contract: USDC_SEPOLIA.toLowerCase(),
      to: TEST_RECIPIENT.toLowerCase(),
      amount: AMOUNT_RAW,
    };
    assert.equal(
      validateQuotedTxAgainstAttestation({ attestation: built.attestation, tx })
        .ok,
      true
    );
    assert.equal(
      assertProposeQuotedArgs({
        operation_id: "op",
        attestation: built.attestation,
        attestation_signature: built.attestation_signature,
        signer_public_key: built.signer_public_key,
        tx,
        expected_epoch: 2,
      }).ok,
      true
    );
  });
});

describe("J17.1 policy views + journal", () => {
  it("verifyPolicyViews uses real fields (not get_state)", () => {
    const ok = verifyPolicyViews({
      get_paused: false,
      get_mandate_epoch: 2,
      get_autonomous_trading: true,
      get_enforce_autonomous_on_agent: true,
      get_revocation_status: { revoked: false },
      get_limits: {
        valid_until: "1893456000000000000",
        allowed_venues: ["near_intents_1click", "evm_transfer"],
        allowed_destinations: [TEST_RECIPIENT],
      },
    });
    assert.equal(ok.ok, true);
    const paused = verifyPolicyViews({
      get_paused: true,
      get_mandate_epoch: 2,
      get_autonomous_trading: true,
      get_enforce_autonomous_on_agent: true,
      get_revocation_status: { revoked: false },
      get_limits: {
        valid_until: "1893456000000000000",
        allowed_venues: ["near_intents_1click"],
        allowed_destinations: [TEST_RECIPIENT],
      },
    });
    assert.equal(paused.ok, false);
    assert.ok(paused.blockers.includes("on_chain_paused"));
  });

  it("journal secret has no predictable fallback", () => {
    const prev = process.env.NIO_TX_JOURNAL_SECRET;
    delete process.env.NIO_TX_JOURNAL_SECRET;
    assert.equal(requireJournalSecret().ok, false);
    process.env.NIO_TX_JOURNAL_SECRET = "short";
    assert.equal(requireJournalSecret().ok, false);
    process.env.NIO_TX_JOURNAL_SECRET = "x".repeat(32);
    assert.equal(requireJournalSecret().ok, true);
    if (prev === undefined) delete process.env.NIO_TX_JOURNAL_SECRET;
    else process.env.NIO_TX_JOURNAL_SECRET = prev;
  });
});
