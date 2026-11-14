import { useMemo, useState } from "react";

/**
 * Mainnet review-only Mandate V1 preview.
 * Does NOT sign, submit, or call policy methods.
 */

type Enforcement = "ON_CHAIN_ENFORCED" | "PLANNED" | "OFF_CHAIN_ONLY";

const DEMO_FIELDS: { label: string; value: string; enforcement: Enforcement }[] = [
  { label: "Network", value: "mainnet (preview only)", enforcement: "ON_CHAIN_ENFORCED" },
  { label: "Policy", value: "policy.nishanthb.near", enforcement: "ON_CHAIN_ENFORCED" },
  { label: "Owner", value: "nishanthb.near", enforcement: "ON_CHAIN_ENFORCED" },
  { label: "Agent", value: "agent.nishanthb.near", enforcement: "ON_CHAIN_ENFORCED" },
  { label: "Max trade (raw)", value: "5000000", enforcement: "ON_CHAIN_ENFORCED" },
  { label: "Daily turnover (raw)", value: "25000000", enforcement: "ON_CHAIN_ENFORCED" },
  { label: "Autonomous trading flag", value: "false (live)", enforcement: "OFF_CHAIN_ONLY" },
  {
    label: "Enforce autonomous on agent",
    value: "false until WASM upgrade + owner toggle",
    enforcement: "PLANNED",
  },
  { label: "Commerce / Agent Market", value: "mocked only", enforcement: "OFF_CHAIN_ONLY" },
  { label: "OpenRouter spend cap", value: "shadow kill-switch", enforcement: "OFF_CHAIN_ONLY" },
  { label: "Min trade interval", value: "not in contract yet", enforcement: "PLANNED" },
];

const badge: Record<Enforcement, string> = {
  ON_CHAIN_ENFORCED: "LIVE ONCHAIN (when deployed)",
  PLANNED: "PLANNED / NOT ENFORCED",
  OFF_CHAIN_ONLY: "OFF-CHAIN ONLY",
};

export function AutonomousMandatePreview() {
  const [wallet, setWallet] = useState<"ledger" | "meteor">("ledger");
  const preview = useMemo(
    () => ({
      mode: "MAINNET_REVIEW_ONLY",
      wallet,
      signing_enabled: false,
      mainnet_mutations: false,
      note: "Identical mandate hash semantics for Ledger and Meteor; physical confirm only after separate owner approval on testnet/mainnet activation.",
    }),
    [wallet]
  );

  return (
    <section className="nio-card" style={{ marginTop: "1.5rem" }}>
      <h2 style={{ marginTop: 0 }}>Autonomous Mandate V1 — review only</h2>
      <p style={{ opacity: 0.85 }}>
        Owner signs a bounded mandate once (Ledger or Meteor). This panel never submits a
        transaction. Live policy remains paused with autonomous funded trading disabled.
      </p>
      <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1rem" }}>
        <button type="button" onClick={() => setWallet("ledger")} aria-pressed={wallet === "ledger"}>
          Ledger NEAR preview
        </button>
        <button type="button" onClick={() => setWallet("meteor")} aria-pressed={wallet === "meteor"}>
          Meteor Wallet preview
        </button>
      </div>
      <p>
        <strong>Mode:</strong> {preview.mode} · <strong>Wallet:</strong> {preview.wallet} ·{" "}
        <strong>signing_enabled:</strong> {String(preview.signing_enabled)}
      </p>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
        <thead>
          <tr>
            <th align="left">Field</th>
            <th align="left">Value</th>
            <th align="left">Enforcement</th>
          </tr>
        </thead>
        <tbody>
          {DEMO_FIELDS.map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td>
                <code>{row.value}</code>
              </td>
              <td>{badge[row.enforcement]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ marginTop: "1rem", fontSize: "0.85rem", opacity: 0.8 }}>{preview.note}</p>
      <p style={{ fontSize: "0.85rem" }}>
        Future entries: <em>Inspect Nishanth&apos;s live mainnet agent</em> ·{" "}
        <em>Set your own mandate</em>
      </p>
    </section>
  );
}
