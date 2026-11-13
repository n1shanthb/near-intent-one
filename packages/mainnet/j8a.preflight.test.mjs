import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chooseGasParams,
  ATTESTOR_PK,
  MPC,
  buildJ8bRunbook,
} from "./j8a.preflight.mjs";
import {
  ATTESTOR_MAX_GAS_PRICE_WEI,
  ATTESTOR_GAS_LIMIT,
} from "./arbitrumFunding.mjs";
import {
  erc20TransferData,
  eip155UnsignedDigest,
  digestHex,
} from "../intents-codec/quote-auth.mjs";
import { buildErc20TxParams } from "./quotePath.mjs";

describe("J8A preflight helpers", () => {
  it("chooses gas under attestor max without Sepolia 1gwei floor", () => {
    const g = chooseGasParams({
      liveGasPriceWei: 20_004_000n,
      estimatedGas: 63_000,
      ethBalanceWei: 63_000_000_000_000n,
    });
    assert.equal(g.ok, true);
    assert.ok(BigInt(g.gas_price) <= ATTESTOR_MAX_GAS_PRICE_WEI);
    assert.ok(BigInt(g.gas_price) >= 20_004_000n);
    assert.ok(BigInt(g.gas_limit) <= ATTESTOR_GAS_LIMIT);
    assert.ok(BigInt(g.gas_price) < 1_000_000_000n);
  });

  it("fails closed when live gas exceeds attestor max", () => {
    const g = chooseGasParams({
      liveGasPriceWei: ATTESTOR_MAX_GAS_PRICE_WEI + 1n,
      estimatedGas: 63_000,
      ethBalanceWei: 10n ** 18n,
    });
    assert.equal(g.ok, false);
    assert.ok(
      g.blockers.some((b) => b.code === "live_gas_price_exceeds_attestor_max")
    );
  });

  it("binds policy.to=escrow and eip155.to=token to the same digest", () => {
    const escrow = "0xc660abc28579c3ef4993b6f3976a903e07ee937b";
    const token = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
    const amount = "1000000";
    const built = buildErc20TxParams({
      depositAddress: escrow,
      tokenContract: token,
      amountIn: amount,
      chainId: 42161,
      nonce: 0,
      gasPrice: 30_000_000n,
      gasLimit: 150_000n,
    });
    assert.equal(built.to, escrow);
    assert.equal(built.token_contract, token);
    const data = erc20TransferData(escrow, amount);
    const digest = digestHex(
      eip155UnsignedDigest({
        nonce: 0,
        gasPrice: 30_000_000n,
        gasLimit: 150_000n,
        to: token,
        data,
        chainId: 42161,
      })
    );
    assert.equal(digest, built.digest_hex);
  });

  it("runbook keeps autonomous off and requires Ledger unpause", () => {
    const rb = buildJ8bRunbook({
      quote: { deposit_address: "0xabc", min_amount_out: "1" },
      gas: { chosen: { ok: true } },
    });
    assert.equal(rb.posture.autonomous_trading, "MUST remain false");
    assert.equal(rb.ledger_actions[0].method, "set_paused");
    assert.equal(rb.ledger_actions[0].args.paused, false);
    assert.ok(ATTESTOR_PK.startsWith("ed25519:"));
    assert.ok(MPC.startsWith("0x"));
  });
});
