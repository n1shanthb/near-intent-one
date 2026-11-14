/**
 * J17.2 — pre-sign safety unit tests (no live MPC / broadcast).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import nacl from "tweetnacl";
import {
  requireFreshGasEstimate,
  fitGasLimit,
  verifyAttestorKeyCorrespondence,
  analyzePendingConflict,
  verifyOneTransferBoundary,
  requireMpcSignBroadcastAuth,
  requireQuoteSignerRegisterAuth,
  persistPreSignIntent,
  loadPreSignIntent,
  requireJournalSecret,
  EXPECTED_ATTESTOR_PK,
  TEST_RECIPIENT,
  USDC_SEPOLIA,
  AMOUNT_RAW,
  CHAIN_ID,
  AUTH_MPC_SIGN_BROADCAST,
  AUTH_QUOTE_SIGNER_REGISTER,
  publicKeyEd25519,
} from "./j17.sepoliaPath.mjs";

describe("J17.2 gas fail-closed", () => {
  it("refuses historical / fallback estimates for readiness", () => {
    const r = requireFreshGasEstimate({
      estimateHexOrBigInt: 142000n,
      gasPrice: 1_000_000_000n,
      maxGasBudget: "500000000000000",
      usedHistoricalFallback: true,
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /historical_gas/);
  });

  it("refuses fitGasLimit when source is historical", () => {
    const r = fitGasLimit({
      estimated: 142000n,
      gasPrice: 1_000_000_000n,
      maxGasBudget: "500000000000000",
      source: "historical",
    });
    assert.equal(r.ok, false);
  });

  it("accepts fresh eth_estimateGas", () => {
    const r = requireFreshGasEstimate({
      estimateHexOrBigInt: 141972n,
      gasPrice: 1_000_000_000n,
      maxGasBudget: "500000000000000",
      usedHistoricalFallback: false,
    });
    assert.equal(r.ok, true);
    assert.ok(BigInt(r.gas_limit) >= 141972n);
  });

  it("fails closed when estimateGas errors", () => {
    const r = requireFreshGasEstimate({
      estimateError: "rpc timeout",
      gasPrice: 1_000_000_000n,
      maxGasBudget: "500000000000000",
    });
    assert.equal(r.ok, false);
  });
});

describe("J17.2 attestor + pending + boundary", () => {
  it("verifies attestor secret corresponds to expected pk", () => {
    const kp = nacl.sign.keyPair();
    const sk = Buffer.from(kp.secretKey);
    const pk = publicKeyEd25519(sk);
    const ok = verifyAttestorKeyCorrespondence({
      secretKey64: sk,
      storedPublicKey: pk,
      expectedPublicKey: pk,
    });
    assert.equal(ok.ok, true);
    const bad = verifyAttestorKeyCorrespondence({
      secretKey64: sk,
      storedPublicKey: pk,
      expectedPublicKey: EXPECTED_ATTESTOR_PK,
    });
    assert.equal(bad.ok, false);
  });

  it("identifies unresolved pending without clearing", () => {
    const a = analyzePendingConflict({
      pendingList: [
        {
          operation_id: "j16-mpc-6890",
          epoch: 2,
          amount_in: "1000000",
          destination: "nio-owner-02b7cf.testnet",
          signing_state: "Signed",
          settlement_state: "None",
          payload_commitment: "abc",
        },
      ],
      reservedExposure: "1000000",
      maxPendingExposure: "2000000",
      nextAmount: AMOUNT_RAW,
      nextDestination: TEST_RECIPIENT,
    });
    assert.equal(a.ok, true);
    assert.equal(a.fits_exposure, true);
    assert.equal(a.same_destination_open, false);
    assert.equal(a.pending[0].clear_without_authority, false);
    assert.match(a.pending[0].action, /LEAVE_IN_PLACE/);
  });

  it("blocks when exposure headroom insufficient", () => {
    const a = analyzePendingConflict({
      pendingList: [
        {
          operation_id: "op",
          amount_in: "2000000",
          destination: "x",
          signing_state: "Reserved",
          settlement_state: "None",
        },
      ],
      reservedExposure: "2000000",
      maxPendingExposure: "2000000",
      nextAmount: AMOUNT_RAW,
    });
    assert.equal(a.ok, false);
    assert.ok(a.blockers.includes("pending_exposure_headroom_insufficient"));
  });

  it("enforces one-transfer boundary", () => {
    const ok = verifyOneTransferBoundary({
      chainId: CHAIN_ID,
      token: USDC_SEPOLIA,
      destination: TEST_RECIPIENT,
      amountRaw: AMOUNT_RAW,
      gasLimit: "170366",
      attemptedTransfers: 1,
    });
    assert.equal(ok.ok, true);
    const bad = verifyOneTransferBoundary({
      chainId: 1,
      token: USDC_SEPOLIA,
      destination: TEST_RECIPIENT,
      amountRaw: "2000000",
      gasLimit: "500000",
      attemptedTransfers: 2,
    });
    assert.equal(bad.ok, false);
    assert.ok(bad.blockers.includes("chain_id_must_be_11155111"));
    assert.ok(bad.blockers.includes("amount_exceeds_fitter_approved_max_1000000"));
    assert.ok(bad.blockers.includes("exactly_one_attempted_transfer_required"));
  });
});

describe("J17.2 dual auth + pre-sign persist + journal", () => {
  it("funding auth alone does not authorize MPC sign/broadcast", () => {
    const env = { J17_SEPOLIA_FUNDING_AUTHORIZED: "1" };
    const r = requireMpcSignBroadcastAuth(env);
    assert.equal(r.ok, false);
    assert.match(r.reason, /funding_auth_does_not_authorize/);
  });

  it("requires explicit MPC sign/broadcast auth", () => {
    assert.equal(requireMpcSignBroadcastAuth({}).ok, false);
    assert.equal(
      requireMpcSignBroadcastAuth({ [AUTH_MPC_SIGN_BROADCAST]: "1" }).ok,
      true
    );
  });

  it("requires separate quote-signer register auth", () => {
    assert.equal(requireQuoteSignerRegisterAuth({}).ok, false);
    assert.equal(
      requireQuoteSignerRegisterAuth({ [AUTH_QUOTE_SIGNER_REGISTER]: "1" }).ok,
      true
    );
  });

  it("persists pre-sign intent and refuses duplicate create", () => {
    const dir = join(
      tmpdir(),
      `j17-presign-${Date.now()}-${randomBytes(2).toString("hex")}`
    );
    mkdirSync(dir, { recursive: true });
    try {
      const first = persistPreSignIntent({
        storeDir: dir,
        operationId: "j17-test-op",
        epoch: 2,
        amount: AMOUNT_RAW,
        destination: TEST_RECIPIENT,
        nonce: 0,
        digestHex: "aa".repeat(32),
        gasLimit: "170366",
        gasPrice: "1000000000",
      });
      assert.equal(first.ok, true);
      assert.equal(first.resumed, false);
      const second = persistPreSignIntent({
        storeDir: dir,
        operationId: "j17-test-op",
        epoch: 2,
        amount: AMOUNT_RAW,
        destination: TEST_RECIPIENT,
        nonce: 0,
        digestHex: "bb".repeat(32),
        gasLimit: "170366",
        gasPrice: "1000000000",
      });
      assert.equal(second.ok, true);
      assert.equal(second.resumed, true);
      assert.equal(second.record.digest_hex, "aa".repeat(32));
      const loaded = loadPreSignIntent({
        storeDir: dir,
        operationId: "j17-test-op",
      });
      assert.equal(loaded.ok, true);
      assert.equal(loaded.record.signing_intent, "request_signature");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("journal secret never auto-regenerates on recovery path", () => {
    const prev = process.env.NIO_TX_JOURNAL_SECRET;
    delete process.env.NIO_TX_JOURNAL_SECRET;
    const missing = requireJournalSecret({
      rootDir: join(tmpdir(), `j17-no-secret-${Date.now()}`),
      allowGenerate: false,
    });
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /NIO_TX_JOURNAL_SECRET_required/);
    if (prev === undefined) delete process.env.NIO_TX_JOURNAL_SECRET;
    else process.env.NIO_TX_JOURNAL_SECRET = prev;
  });
});
