import { describe, expect, it } from "vitest";
import { __test_ownerStorageKey } from "./ProductSession";

describe("per-owner portfolio cache keys", () => {
  it("uses distinct keys for user A and B", () => {
    const a = __test_ownerStorageKey("nio-i-a4e7-a-owner.testnet");
    const b = __test_ownerStorageKey("owner.nio-i-a4e7-agent.testnet");
    expect(a).not.toBe(b);
    expect(a).toContain("nio-i-a4e7-a-owner.testnet");
    expect(b).toContain("owner.nio-i-a4e7-agent.testnet");
  });
});
