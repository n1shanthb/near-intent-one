import { describe, expect, it } from "vitest";
import {
  derivePhase,
  isHardwareOwnershipPass,
  ledgerAuthorizedOn,
  softwareFullAccessKeys,
  type WizardProofs,
} from "./wizardState";

const ledger = "ed25519:LedgerPk1111111111111111111111111111111111";
const software = "ed25519:SoftPk111111111111111111111111111111111111";

function base(partial: Partial<WizardProofs> = {}): WizardProofs {
  return {
    ledgerPublicKey: null,
    derivationPath: "44'/397'/0'/0'/1'",
    ownerKeys: [],
    policyKeys: [],
    addOwnerTx: null,
    addPolicyTx: null,
    setPolicyTx: null,
    revokeTx: null,
    unrevokeTx: null,
    removeOwnerSoftwareTx: null,
    removePolicySoftwareTx: null,
    setPolicyOk: false,
    revokeOk: false,
    mandateEpochAfterRevoke: null,
    revokedAfter: null,
    ...partial,
  };
}

describe("ledger wizard state", () => {
  it("stays disconnected without a ledger public key", () => {
    expect(derivePhase(base())).toBe("disconnected");
    expect(isHardwareOwnershipPass(derivePhase(base()))).toBe(false);
  });

  it("does not pass merely because a device connected", () => {
    const phase = derivePhase(
      base({
        ledgerPublicKey: ledger,
        ownerKeys: [{ public_key: software, permission: "FullAccess" }],
        policyKeys: [{ public_key: software, permission: "FullAccess" }],
      })
    );
    expect(phase).toBe("connected_unauthorized");
    expect(isHardwareOwnershipPass(phase)).toBe(false);
  });

  it("requires policy+revoke proofs before hardware-only", () => {
    const registered = derivePhase(
      base({
        ledgerPublicKey: ledger,
        ownerKeys: [
          { public_key: ledger, permission: "FullAccess" },
          { public_key: software, permission: "FullAccess" },
        ],
        policyKeys: [{ public_key: ledger, permission: "FullAccess" }],
      })
    );
    expect(registered).toBe("hardware_key_registered");

    const policyVerified = derivePhase(
      base({
        ledgerPublicKey: ledger,
        ownerKeys: [
          { public_key: ledger, permission: "FullAccess" },
          { public_key: software, permission: "FullAccess" },
        ],
        policyKeys: [{ public_key: ledger, permission: "FullAccess" }],
        setPolicyOk: true,
        setPolicyTx: "abc",
      })
    );
    expect(policyVerified).toBe("hardware_policy_verified");

    const revokeVerified = derivePhase(
      base({
        ledgerPublicKey: ledger,
        ownerKeys: [
          { public_key: ledger, permission: "FullAccess" },
          { public_key: software, permission: "FullAccess" },
        ],
        policyKeys: [{ public_key: ledger, permission: "FullAccess" }],
        setPolicyOk: true,
        revokeOk: true,
      })
    );
    expect(revokeVerified).toBe("software_still_active");
    expect(isHardwareOwnershipPass(revokeVerified)).toBe(false);
  });

  it("passes only when software keys are gone and proofs exist", () => {
    const phase = derivePhase(
      base({
        ledgerPublicKey: ledger,
        ownerKeys: [{ public_key: ledger, permission: "FullAccess" }],
        policyKeys: [{ public_key: ledger, permission: "FullAccess" }],
        setPolicyOk: true,
        revokeOk: true,
        setPolicyTx: "p",
        revokeTx: "r",
      })
    );
    expect(phase).toBe("hardware_only_verified");
    expect(isHardwareOwnershipPass(phase)).toBe(true);
  });

  it("classifies software vs ledger keys", () => {
    const keys = [
      { public_key: ledger, permission: "FullAccess" as const },
      { public_key: software, permission: "FullAccess" as const },
    ];
    expect(ledgerAuthorizedOn(keys, ledger)).toBe(true);
    expect(softwareFullAccessKeys(keys, ledger).map((k) => k.public_key)).toEqual([
      software,
    ]);
  });
});
