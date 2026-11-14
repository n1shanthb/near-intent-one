import test from "node:test";
import assert from "node:assert/strict";
import {
  isViewError,
  unwrapView,
  asTriBool,
} from "./mainnetPublicAudit.mjs";

test("isViewError detects RPC error envelopes", () => {
  assert.equal(isViewError({ error: "x" }), true);
  assert.equal(isViewError({ error: { code: -429 } }), true);
  assert.equal(isViewError({ max_trade_value: "1000000" }), false);
  assert.equal(isViewError(null), false);
  assert.equal(isViewError(true), false);
});

test("unwrapView never returns error envelopes", () => {
  assert.equal(unwrapView({ error: "rate" }, null), null);
  assert.equal(unwrapView(true, null), true);
  assert.equal(unwrapView(false, null), false);
  assert.equal(unwrapView(null, "fallback"), "fallback");
});

test("asTriBool keeps UNKNOWN as null — never false", () => {
  assert.equal(asTriBool(true), true);
  assert.equal(asTriBool(false), false);
  assert.equal(asTriBool(null), null);
  assert.equal(asTriBool(undefined), null);
  assert.equal(asTriBool({ error: "x" }), null);
  assert.equal(asTriBool("true"), true);
  assert.equal(asTriBool("false"), false);
});
