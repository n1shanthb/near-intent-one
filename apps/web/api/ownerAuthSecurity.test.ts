import { describe, expect, it } from "vitest";
import {
  assertMutationCsrf,
  normalizeOwnerRoute,
  requireOwnerAuthSecret,
  resolveOwnerAction,
  stripSessionTokenFromBody,
  unwrapSessionToken,
  wrapSessionToken,
} from "./ownerAuthSecurity.mjs";

describe("ownerAuthSecurity", () => {
  it("fail-closed without dedicated secret", () => {
    expect(requireOwnerAuthSecret({}).ok).toBe(false);
    expect(requireOwnerAuthSecret({ NIO_OWNER_AUTH_SECRET: "short" }).ok).toBe(
      false
    );
  });

  it("rejects secret equal to GATE_I_API_KEY", () => {
    const secret = "x".repeat(40);
    const res = requireOwnerAuthSecret({
      NIO_OWNER_AUTH_SECRET: secret,
      GATE_I_API_KEY: secret,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/differ/);
  });

  it("accepts strong independent secret", () => {
    const res = requireOwnerAuthSecret({
      NIO_OWNER_AUTH_SECRET: "a".repeat(32),
      GATE_I_API_KEY: "b".repeat(32),
    });
    expect(res.ok).toBe(true);
  });

  it("wraps and unwraps session cookie integrity", () => {
    const secret = "c".repeat(32);
    const token = "nio1.exampletoken";
    const wrapped = wrapSessionToken(token, secret);
    expect(unwrapSessionToken(wrapped, secret)).toBe(token);
    expect(unwrapSessionToken(wrapped + "x", secret)).toBeNull();
    expect(unwrapSessionToken(wrapped, "d".repeat(32))).toBeNull();
    expect(unwrapSessionToken("forged~deadbeef", secret)).toBeNull();
  });

  it("strips session token from verify body", () => {
    const out = stripSessionTokenFromBody({
      ok: true,
      session: { token: "nio1.secret", account_id: "a.testnet" },
    });
    expect(out.session.token).toBeUndefined();
    expect(out.session.cookie).toBe(true);
    expect(out.session.account_id).toBe("a.testnet");
  });

  it("enforces CSRF origin match on mutations", () => {
    expect(
      assertMutationCsrf({
        method: "POST",
        host: "near-intent-one.vercel.app",
        origin: "https://near-intent-one.vercel.app",
      }).ok
    ).toBe(true);
    expect(
      assertMutationCsrf({
        method: "POST",
        host: "near-intent-one.vercel.app",
        origin: "https://evil.example",
      }).ok
    ).toBe(false);
    expect(
      assertMutationCsrf({
        method: "GET",
        host: "near-intent-one.vercel.app",
      }).ok
    ).toBe(true);
  });

  it("enforces double-submit CSRF when cookie present", () => {
    expect(
      assertMutationCsrf({
        method: "POST",
        host: "near-intent-one.vercel.app",
        origin: "https://near-intent-one.vercel.app",
        csrfCookie: "abc",
        csrfHeader: "abc",
      }).ok
    ).toBe(true);
    expect(
      assertMutationCsrf({
        method: "POST",
        host: "near-intent-one.vercel.app",
        origin: "https://near-intent-one.vercel.app",
        csrfCookie: "abc",
        csrfHeader: "xyz",
      }).ok
    ).toBe(false);
  });

  it("allowlists only owner routes", () => {
    expect(normalizeOwnerRoute("POST", "/challenge")).toBe("POST /challenge");
    expect(normalizeOwnerRoute("GET", "/")).toBe("GET /session");
    expect(resolveOwnerAction("/api/owner-auth/verify", "localhost")).toBe(
      "/verify"
    );
    expect(
      resolveOwnerAction("/api/owner-auth?action=gate-k", "localhost")
    ).toBe("/gate-k");
  });
});
