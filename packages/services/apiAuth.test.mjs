import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  allowOpenDevMode,
  authorizeService,
  authorizePortfolioOwner,
  isPrivateAgentPath,
  isDemoPortfolioId,
} from "./apiAuth.mjs";

describe("apiAuth — fail-closed service auth (SEC-P1-04)", () => {
  it("rejects mutations when API key missing outside localhost open-dev", () => {
    const env = { GATE_I_HOST: "0.0.0.0", GATE_I_API_KEY: "" };
    const r = authorizeService(
      { headers: {}, socket: { remoteAddress: "10.0.0.5" } },
      { mutating: true, apiKey: "", env }
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, "api_key_required");
  });

  it("allows open_dev only with GATE_I_ALLOW_OPEN_DEV=1 on localhost", () => {
    const env = {
      GATE_I_ALLOW_OPEN_DEV: "1",
      GATE_I_HOST: "127.0.0.1",
      GATE_I_API_KEY: "",
    };
    assert.equal(allowOpenDevMode(env, { remoteAddress: "127.0.0.1" }), true);
    const r = authorizeService(
      { headers: {}, socket: { remoteAddress: "127.0.0.1" } },
      { mutating: true, apiKey: "", env }
    );
    assert.equal(r.ok, true);
    assert.equal(r.mode, "open_dev_localhost_only");
  });

  it("rejects open_dev on public bind even with flag", () => {
    const env = {
      GATE_I_ALLOW_OPEN_DEV: "1",
      GATE_I_HOST: "0.0.0.0",
    };
    assert.equal(allowOpenDevMode(env, { remoteAddress: "8.8.8.8" }), false);
  });

  it("rejects wrong API key", () => {
    const r = authorizeService(
      { headers: { "x-api-key": "wrong" }, socket: {} },
      { mutating: true, apiKey: "correct", env: {} }
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, "unauthorized");
  });

  it("accepts matching API key", () => {
    const r = authorizeService(
      { headers: { "x-api-key": "correct" }, socket: {} },
      { mutating: true, apiKey: "correct", env: {} }
    );
    assert.equal(r.ok, true);
  });

  it("GET/non-mutating does not require key", () => {
    const r = authorizeService(
      { headers: {} },
      { mutating: false, apiKey: "", env: { GATE_I_HOST: "0.0.0.0" } }
    );
    assert.equal(r.ok, true);
  });
});

describe("apiAuth — owner session on agent control (SEC-P1-03)", () => {
  const portfolio = {
    portfolio_id: "i-u-abcd1234",
    owner_account: "alice.testnet",
    policy_contract: "policy.alice.testnet",
    deploy_status: "ready",
  };

  it("requires owner session", () => {
    const r = authorizePortfolioOwner({
      portfolioId: "i-u-abcd1234",
      portfolio,
      session: { ok: false, reason: "owner_session_required" },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "owner_session_required");
  });

  it("rejects expired session", () => {
    const r = authorizePortfolioOwner({
      portfolioId: "i-u-abcd1234",
      portfolio,
      session: {
        ok: true,
        account_id: "alice.testnet",
        session_id: "s1",
        expires_at: new Date(Date.now() - 1000).toISOString(),
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "session_expired");
  });

  it("rejects wrong owner (cross-tenant)", () => {
    const r = authorizePortfolioOwner({
      portfolioId: "i-u-abcd1234",
      portfolio,
      session: {
        ok: true,
        account_id: "eve.testnet",
        session_id: "s1",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "owner_mismatch");
  });

  it("rejects unknown portfolio / spoofed id", () => {
    assert.equal(
      authorizePortfolioOwner({
        portfolioId: "i-u-abcd1234",
        portfolio: null,
        session: {
          ok: true,
          account_id: "alice.testnet",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      }).reason,
      "unknown_portfolio"
    );
    assert.equal(
      authorizePortfolioOwner({
        portfolioId: "../etc/passwd",
        portfolio,
        session: {
          ok: true,
          account_id: "alice.testnet",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      }).reason,
      "portfolio_id_spoof_rejected"
    );
  });

  it("rejects portfolio_id mismatch in store row", () => {
    const r = authorizePortfolioOwner({
      portfolioId: "i-u-abcd1234",
      portfolio: { ...portfolio, portfolio_id: "other-id" },
      session: {
        ok: true,
        account_id: "alice.testnet",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "portfolio_id_mismatch");
  });

  it("passes matching owner + ready portfolio", () => {
    const r = authorizePortfolioOwner({
      portfolioId: "i-u-abcd1234",
      portfolio,
      session: {
        ok: true,
        account_id: "alice.testnet",
        session_id: "s1",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
      requireReady: true,
    });
    assert.equal(r.ok, true);
    assert.equal(r.account_id, "alice.testnet");
  });

  it("concurrent wrong-owner and right-owner stay isolated", async () => {
    const sessionOk = {
      ok: true,
      account_id: "alice.testnet",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    const sessionBad = {
      ok: true,
      account_id: "bob.testnet",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        Promise.resolve(
          authorizePortfolioOwner({
            portfolioId: "i-u-abcd1234",
            portfolio,
            session: i % 2 === 0 ? sessionOk : sessionBad,
          })
        )
      )
    );
    const oks = results.filter((r) => r.ok);
    const fails = results.filter((r) => !r.ok);
    assert.equal(oks.length, 10);
    assert.equal(fails.length, 10);
    assert.ok(fails.every((r) => r.reason === "owner_mismatch"));
  });
});

describe("apiAuth — BFF private agent paths", () => {
  it("flags agent start/stop/state as private", () => {
    assert.equal(isPrivateAgentPath("/portfolios/i-u-1/agent/start"), true);
    assert.equal(isPrivateAgentPath("/v1/portfolios/i-u-1/agent/stop"), true);
    assert.equal(isPrivateAgentPath("/portfolios/i-u-1/agent"), true);
    assert.equal(isPrivateAgentPath("/gate-j/demo-decide"), false);
  });

  it("knows demo portfolio ids", () => {
    assert.equal(isDemoPortfolioId("i-a-a4e7"), true);
    assert.equal(isDemoPortfolioId("i-u-xyz"), false);
  });
});
