import type { AccessKeyInfo } from "./rpc";

export type LedgerWizardPhase =
  | "disconnected"
  | "connected_unauthorized"
  | "hardware_key_registered"
  | "hardware_policy_verified"
  | "hardware_revoke_verified"
  | "software_still_active"
  | "hardware_only_verified";

export type WizardProofs = {
  ledgerPublicKey: string | null;
  derivationPath: string;
  ownerKeys: AccessKeyInfo[];
  policyKeys: AccessKeyInfo[];
  addOwnerTx: string | null;
  addPolicyTx: string | null;
  setPolicyTx: string | null;
  revokeTx: string | null;
  unrevokeTx: string | null;
  removeOwnerSoftwareTx: string | null;
  removePolicySoftwareTx: string | null;
  setPolicyOk: boolean;
  revokeOk: boolean;
  mandateEpochAfterRevoke: number | null;
  revokedAfter: boolean | null;
};

export function normalizePk(pk: string): string {
  return pk.startsWith("ed25519:") ? pk : `ed25519:${pk}`;
}

export function softwareFullAccessKeys(
  keys: AccessKeyInfo[],
  ledgerPublicKey: string | null
): AccessKeyInfo[] {
  const ledger = ledgerPublicKey ? normalizePk(ledgerPublicKey) : null;
  return keys.filter(
    (k) => k.permission === "FullAccess" && (!ledger || k.public_key !== ledger)
  );
}

export function ledgerAuthorizedOn(
  keys: AccessKeyInfo[],
  ledgerPublicKey: string | null
): boolean {
  if (!ledgerPublicKey) return false;
  const ledger = normalizePk(ledgerPublicKey);
  return keys.some((k) => k.permission === "FullAccess" && k.public_key === ledger);
}

/** Distinct UI status — NEVER mark PASS merely because a device connected. */
export function derivePhase(proofs: WizardProofs): LedgerWizardPhase {
  if (!proofs.ledgerPublicKey) return "disconnected";

  const ownerOk = ledgerAuthorizedOn(proofs.ownerKeys, proofs.ledgerPublicKey);
  const policyOk = ledgerAuthorizedOn(proofs.policyKeys, proofs.ledgerPublicKey);
  if (!ownerOk || !policyOk) return "connected_unauthorized";

  const softwareOwner = softwareFullAccessKeys(proofs.ownerKeys, proofs.ledgerPublicKey);
  const softwarePolicy = softwareFullAccessKeys(proofs.policyKeys, proofs.ledgerPublicKey);
  const anySoftware = softwareOwner.length > 0 || softwarePolicy.length > 0;

  if (
    proofs.setPolicyOk &&
    proofs.revokeOk &&
    !anySoftware &&
    ownerOk &&
    policyOk
  ) {
    return "hardware_only_verified";
  }

  if (proofs.setPolicyOk && proofs.revokeOk && anySoftware) {
    return "software_still_active";
  }

  if (proofs.revokeOk) return "hardware_revoke_verified";
  if (proofs.setPolicyOk) return "hardware_policy_verified";
  return "hardware_key_registered";
}

export function phaseLabel(phase: LedgerWizardPhase): string {
  switch (phase) {
    case "disconnected":
      return "Ledger disconnected";
    case "connected_unauthorized":
      return "Connected but not authorized";
    case "hardware_key_registered":
      return "Hardware key registered";
    case "hardware_policy_verified":
      return "Hardware policy signature verified";
    case "hardware_revoke_verified":
      return "Hardware revocation verified";
    case "software_still_active":
      return "Software owner key still active";
    case "hardware_only_verified":
      return "Hardware-only ownership verified";
  }
}

export function phaseTone(
  phase: LedgerWizardPhase
): "muted" | "warn" | "ok" | "danger" {
  switch (phase) {
    case "hardware_only_verified":
      return "ok";
    case "disconnected":
    case "connected_unauthorized":
      return "warn";
    case "software_still_active":
      return "warn";
    case "hardware_key_registered":
    case "hardware_policy_verified":
    case "hardware_revoke_verified":
      return "ok";
    default:
      return "muted";
  }
}

/** Gate H PASS only when hardware-only ownership is proven. */
export function isHardwareOwnershipPass(phase: LedgerWizardPhase): boolean {
  return phase === "hardware_only_verified";
}
