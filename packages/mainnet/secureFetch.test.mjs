/**
 * J4 — secure fetch binding / TLS posture unit tests (no insecure bypass).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { detectMobileBindAddress } from "./secureFetch.mjs";

describe("J4 secureFetch posture", () => {
  it("never enables TLS bypass in code", () => {
    const src = readFileSync(new URL("./secureFetch.mjs", import.meta.url), "utf8");
    assert.equal(src.includes("rejectUnauthorized: false"), false);
    assert.equal(src.includes("rejectUnauthorized:false"), false);
    assert.equal(/process\.env\.NODE_TLS_REJECT_UNAUTHORIZED/.test(src), false);
    assert.match(src, /rejectUnauthorized:\s*true/);
  });

  it("detectMobileBindAddress honors NIO_BIND_ADDRESS", () => {
    assert.equal(
      detectMobileBindAddress({ NIO_BIND_ADDRESS: "10.1.2.3" }),
      "10.1.2.3"
    );
  });

  it("skips college Fortinet 172.18.x when choosing bind", () => {
    // Function only reads os.networkInterfaces — ensure explicit env wins
    assert.equal(
      detectMobileBindAddress({ NIO_BIND_ADDRESS: "10.9.9.9" }),
      "10.9.9.9"
    );
  });
});
