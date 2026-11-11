import {
  MAINNET_EVIDENCE,
  hasVerifiedMainnetContract,
} from "../../data/mainnetEvidence";
import {
  CAPABILITY_LABELS,
  mainnetAccountExplorer,
  mainnetTradingControlsEnabled,
  mainnetTxExplorer,
} from "../../lib/network";
import type { NavId } from "./nav";

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    /* ignore */
  }
}

function ProofRow({
  label,
  value,
  href,
}: {
  label: string;
  value: string | null;
  href?: string | null;
}) {
  const display = value || "— not verified —";
  const short =
    value && value.length > 28
      ? `${value.slice(0, 12)}…${value.slice(-10)}`
      : display;
  return (
    <div className="nio-hash-row">
      <span>{label}</span>
      <code className="mono">{short}</code>
      <div className="nio-hash-actions">
        {value ? (
          <button
            type="button"
            className="axis-button secondary"
            onClick={() => void copyText(value)}
          >
            Copy
          </button>
        ) : null}
        {href ? (
          <a
            className="axis-button secondary"
            href={href}
            target="_blank"
            rel="noreferrer"
          >
            Explorer
          </a>
        ) : null}
      </div>
    </div>
  );
}

export function MainnetEvidencePage({ onNav }: { onNav: (id: NavId) => void }) {
  const ev = MAINNET_EVIDENCE;
  const ready = hasVerifiedMainnetContract(ev);
  const trading = mainnetTradingControlsEnabled(ev);
  const accountHref = mainnetAccountExplorer(ev.contract.account_id, ev);
  const deployHref = mainnetTxExplorer(ev.contract.deploy_tx, ev);
  const fundedHref = mainnetTxExplorer(ev.funded_trade.tx_hash, ev);

  return (
    <div className="page-enter nio-mainnet-page">
      <div className="axis-intro">
        <div>
          <h1>Mainnet evidence</h1>
          <p>
            Independently verified NEAR mainnet proof for NIO. Testnet Gate K /
            Sepolia receipts stay on Evidence and are never relabeled as mainnet.
          </p>
        </div>
      </div>

      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>Verification status</h2>
          <span
            className={`nio-badge ${ready ? "nio-badge-success" : "nio-badge-warn"}`}
          >
            {ready ? "MAINNET PROOF VERIFIED" : "AWAITING CHAT 1 PROOF"}
          </span>
        </div>
        {!ready ? (
          <div className="nio-empty-state">
            <p>
              No independently verified NIO mainnet contract deployment has been
              supplied yet. Contract account, deploy transaction, and policy
              state will appear here only after Chat 1 confirms them on-chain.
            </p>
            <p className="axis-supporting">
              Public Live AI remains a testnet dry-run. Owner-auth sessions on
              testnet do not authenticate mainnet accounts.
            </p>
          </div>
        ) : (
          <dl className="nio-kv">
            <div>
              <dt>Verified at</dt>
              <dd className="mono">{ev.verified_at}</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{ev.verification_source ?? "—"}</dd>
            </div>
          </dl>
        )}
      </section>

      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>Capability matrix</h2>
        </div>
        <div className="nio-capability-grid">
          {(Object.keys(CAPABILITY_LABELS) as (keyof typeof CAPABILITY_LABELS)[]).map(
            (key) => {
              const on = ev.capabilities[key];
              return (
                <div key={key} data-on={on ? "1" : "0"}>
                  <span
                    className={`nio-badge ${on ? "nio-badge-success" : "nio-badge-idle"}`}
                  >
                    {on ? "YES" : "NO"}
                  </span>
                  <strong>{CAPABILITY_LABELS[key]}</strong>
                </div>
              );
            }
          )}
        </div>
      </section>

      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>Contract account</h2>
        </div>
        <ProofRow
          label="Account"
          value={ev.contract.account_id}
          href={accountHref}
        />
        <ProofRow
          label="Deploy tx"
          value={ev.contract.deploy_tx}
          href={deployHref}
        />
        <ProofRow label="Code hash" value={ev.contract.code_hash} />
      </section>

      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>Policy state</h2>
          <span
            className={`nio-badge ${
              ev.policy.active ? "nio-badge-success" : "nio-badge-idle"
            }`}
          >
            {ev.policy.active ? "ACTIVE" : "NOT ACTIVE"}
          </span>
        </div>
        <dl className="nio-kv">
          <div>
            <dt>Owner</dt>
            <dd className="mono">{ev.policy.owner_account ?? "—"}</dd>
          </div>
          <div>
            <dt>Epoch</dt>
            <dd className="mono">{ev.policy.epoch ?? "—"}</dd>
          </div>
          <div>
            <dt>Policy hash</dt>
            <dd className="mono">{ev.policy.policy_hash ?? "—"}</dd>
          </div>
        </dl>
      </section>

      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>MPC signer · Intents</h2>
        </div>
        <dl className="nio-kv">
          <div>
            <dt>MPC signer</dt>
            <dd className="mono">{ev.mpc.signer_contract ?? "—"}</dd>
          </div>
          <div>
            <dt>MPC status</dt>
            <dd>{ev.mpc.integration_status}</dd>
          </div>
          <div>
            <dt>Derived EVM</dt>
            <dd className="mono">{ev.mpc.derived_evm_address ?? "—"}</dd>
          </div>
          <div>
            <dt>Intents verifier</dt>
            <dd className="mono">{ev.intents.verifier_account ?? "—"}</dd>
          </div>
          <div>
            <dt>Quote status</dt>
            <dd>{ev.intents.quote_status}</dd>
          </div>
          <div>
            <dt>Intents integration</dt>
            <dd>{ev.intents.integration_status}</dd>
          </div>
        </dl>
      </section>

      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>Funded trade status</h2>
          <span
            className={`nio-badge ${
              ev.funded_trade.proven ? "nio-badge-success" : "nio-badge-idle"
            }`}
          >
            {ev.funded_trade.proven ? "PROVEN" : "NOT PROVEN"}
          </span>
        </div>
        <ProofRow
          label="Trade tx"
          value={ev.funded_trade.tx_hash}
          href={fundedHref}
        />
        <p className="axis-supporting" style={{ marginTop: 10 }}>
          {ev.funded_trade.note}
          {ev.funded_trade.amount_label
            ? ` · ${ev.funded_trade.amount_label}`
            : ""}
        </p>
      </section>

      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>Mainnet trading controls</h2>
          <span className="nio-badge nio-badge-danger">
            {trading ? "GATED" : "DISABLED"}
          </span>
        </div>
        <p>
          Owner-only mainnet trading stays disabled until Chat 1 confirms exact
          endpoint contracts and security gates. Public BFF allowlists are
          unchanged — no public execution access.
        </p>
        <div className="axis-actions" style={{ marginTop: 12, flexWrap: "wrap" }}>
          <button
            type="button"
            className="axis-button"
            disabled
            title="Disabled until Chat 1 verifies mainnet trading gates"
          >
            Mainnet trade (disabled)
          </button>
          <button
            type="button"
            className="axis-button secondary"
            onClick={() => onNav("evidence")}
          >
            Open testnet Gate K evidence
          </button>
          <button
            type="button"
            className="axis-button secondary"
            onClick={() => onNav("owner")}
          >
            Owner auth (network-bound)
          </button>
        </div>
        <ul className="nio-owner-actions" style={{ marginTop: 14 }}>
          {ev.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
