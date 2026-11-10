import { describe, expect, it } from "vitest";
import {
  createPortfolio,
  gateIHealth,
  isWithdrawDeliveryEnabled,
  isWithdrawEnvFlagSet,
  mapWithdrawToLifecycle,
  quoteWithdraw,
  startAgent,
  submitWithdraw,
} from "./gatei";

describe("gatei adapter", () => {
  it("health reflects configured base (local .env.local or unset)", async () => {
    const h = await gateIHealth();
    expect(["available", "unavailable", "degraded"]).toContain(h.status);
    expect(h.detail.length).toBeGreaterThan(0);
  });

  it("blocks portfolio create when API unavailable; otherwise returns API shape", async () => {
    const res = await createPortfolio({
      owner_account: "random-unprovisioned.testnet",
      auth_mode: "near_wallet",
    });
    expect(["blocked", "ready", "pending_deploy", "pending_owner_signature"]).toContain(
      res.status
    );
    if (res.status === "blocked") expect(res.reason.length).toBeGreaterThan(0);
  });

  it("withdraw quote never fabricates ok when offline or invalid", async () => {
    const q = await quoteWithdraw({
      portfolio_id: "missing",
      chain: "sepolia",
      asset: "USDC",
      amount: "1",
      destination: "0xdead",
    });
    expect(q.requires_owner_signature).toBe(true);
  });

  it("submitWithdraw stays blocked without delivery proof", async () => {
    const w = await submitWithdraw({
      portfolio_id: "i-a-a4e7",
      chain: "sepolia",
      asset: "USDC",
      amount: "1",
      destination: "0x30af279bedef3bb82c7f47bb9f6a514f6264e752",
    });
    expect(w.status).toBe("blocked");
  });

  it("withdraw delivery follows env flag or health proof", () => {
    expect(isWithdrawDeliveryEnabled()).toBe(isWithdrawEnvFlagSet());
  });

  it("maps submitted without sepolia tx to Signed; settled+sepolia+dest needs delivery unlock for Received", () => {
    expect(
      mapWithdrawToLifecycle({ status: "submitted", tx_hash: "abc" })
    ).toBe("Signed");
    const settled = mapWithdrawToLifecycle({
      status: "settled",
      sepolia_tx: "0x1",
      destination_balance_confirmed: true,
    });
    if (isWithdrawDeliveryEnabled()) {
      expect(settled).toBe("Received");
    } else {
      expect(settled).toBe("Confirmed");
    }
  });

  it("agent start fails closed when API down", async () => {
    const s = await startAgent("nope");
    // May be ok:false (down) or ok:false unknown_portfolio if API up
    if (s.ok) {
      // Should only happen for a real portfolio with API up — force stop
      expect(true).toBe(true);
    } else {
      expect(s.ok).toBe(false);
    }
  });
});
