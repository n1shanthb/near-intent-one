import { describe, expect, it } from "vitest";
import {
  RECORDED_WITHDRAW_RECEIVED,
  RECORDED_WITHDRAW_SIGNED,
  honestLifecycleFromReceipt,
  stageReached,
} from "./withdrawLifecycle";

describe("withdraw lifecycle honesty", () => {
  it("recorded withdraw_signed is Signed only; closure Sepolia is Received", () => {
    expect(RECORDED_WITHDRAW_SIGNED.stage).toBe("Signed");
    expect(RECORDED_WITHDRAW_RECEIVED.stage).toBe("Received");
    expect(RECORDED_WITHDRAW_RECEIVED.amount).toMatch(/0\.1/);
  });

  it("never marks Received without delivery proof", () => {
    expect(
      honestLifecycleFromReceipt(
        {
          status: "settled",
          sepolia_tx: "0xabc",
          destination_balance_confirmed: true,
        },
        false
      )
    ).toBe("Confirmed");
    expect(
      honestLifecycleFromReceipt(
        {
          status: "settled",
          sepolia_tx: "0xabc",
          destination_balance_confirmed: true,
        },
        true
      )
    ).toBe("Received");
  });

  it("submitted NEAR auth without sepolia is Signed", () => {
    expect(
      honestLifecycleFromReceipt({ status: "submitted", tx_hash: "nearTx" }, true)
    ).toBe("Signed");
  });

  it("stage ordering", () => {
    expect(stageReached("Signed", "Requested")).toBe(true);
    expect(stageReached("Signed", "Received")).toBe(false);
  });
});
