import { describe, expect, it } from "vitest";
import { classifyOwnerError } from "./ownerAuth";

describe("classifyOwnerError", () => {
  it("maps WebHID and Ledger app failures", () => {
    expect(classifyOwnerError("WebHID unsupported — use Chrome").kind).toBe(
      "webhid_unsupported"
    );
    expect(classifyOwnerError("NEAR app is not open on the Ledger").kind).toBe(
      "near_app_closed"
    );
    expect(
      classifyOwnerError("NEAR Ledger app 2.0.0 cannot sign NEP-413 messages").kind
    ).toBe("app_version_unsupported");
  });

  it("maps access-key and signature failures", () => {
    expect(classifyOwnerError("full_access_key_required — FunctionCall-limited").kind).toBe(
      "full_access_missing"
    );
    expect(classifyOwnerError("Rejected on the Ledger device (0x6985)").kind).toBe(
      "signature_rejected"
    );
    expect(classifyOwnerError("session_expired").kind).toBe("session_expired");
  });

  it("maps upstream / secret misconfig without exposing secrets", () => {
    const up = classifyOwnerError("upstream_unreachable");
    expect(up.kind).toBe("upstream_down");
    expect(up.recovery.toLowerCase()).not.toMatch(/api[_-]?key|secret|nio1\./);
    const sec = classifyOwnerError("owner_auth_secret_missing");
    expect(sec.kind).toBe("secret_misconfigured");
  });
});
