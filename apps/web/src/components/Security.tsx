import {
  ADVERSARIAL_DEMOS,
  GATE_G_ACCOUNTING,
  HARDWARE_OWNERSHIP,
} from "../data/evidenceSnapshot";
import { SECURITY_DEMOS } from "../data/receipts";
import { CONFIG } from "../lib/config";

export function Security({ onOpenLedger }: { onOpenLedger?: () => void }) {
  return (
    <div className="stack">
      <section className="card alert">
        <h3>Revocation model (Gate E3 — preserved)</h3>
        <p>
          <strong>
            Revocation prevents new authorizations. Previously signed transactions
            may remain executable.
          </strong>
        </p>
        <p className="muted">
          Hardware revoke proof:{" "}
          <a
            href={`${CONFIG.nearblocks}/txns/${HARDWARE_OWNERSHIP.revokeTx}`}
            target="_blank"
            rel="noreferrer"
          >
            {HARDWARE_OWNERSHIP.revokeTx.slice(0, 14)}…
          </a>{" "}
          → revoked=true epoch {HARDWARE_OWNERSHIP.revokeVerified.mandate_epoch}.
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Ledger-only authority</h3>
          <span className="badge badge-pass">{GATE_G_ACCOUNTING.ledger.label}</span>
        </div>
        <dl className="kv">
          <dt>Ledger key</dt>
          <dd className="mono">{HARDWARE_OWNERSHIP.ledgerPublicKey}</dd>
          <dt>set_policy</dt>
          <dd className="mono">
            <a
              href={`${CONFIG.nearblocks}/txns/${HARDWARE_OWNERSHIP.setPolicyTx}`}
              target="_blank"
              rel="noreferrer"
            >
              {HARDWARE_OWNERSHIP.setPolicyTx}
            </a>
          </dd>
          <dt>Software FA left</dt>
          <dd>{GATE_G_ACCOUNTING.ledger.softwareFullAccessRemaining}</dd>
        </dl>
        <p className="muted small">{HARDWARE_OWNERSHIP.note}</p>
        <button type="button" onClick={() => onOpenLedger?.()}>
          Open Ledger setup wizard
        </button>
      </section>

      <section className="card">
        <h3>Separate reconciler (H2)</h3>
        <p>
          Reconciler <span className="mono">{GATE_G_ACCOUNTING.reconciler}</span> is
          not the trading agent. Contract stores evidence_hash with
          verified_onchain=false.
        </p>
      </section>

      <section className="card">
        <h3>Rejection gallery</h3>
        <ul className="demo-list">
          {[...ADVERSARIAL_DEMOS, ...SECURITY_DEMOS].map((d) => (
            <li key={d.id}>
              <div className="row between">
                <strong>{d.title}</strong>
                <span className="badge badge-danger">
                  {"result" in d ? d.result : d.expect}
                </span>
              </div>
              <p className="muted">{"detail" in d ? d.detail : d.how}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
