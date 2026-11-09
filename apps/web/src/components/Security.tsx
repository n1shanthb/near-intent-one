import { ADVERSARIAL_DEMOS, GATE_G_ACCOUNTING } from "../data/evidenceSnapshot";
import { SECURITY_DEMOS } from "../data/receipts";

export function Security() {
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
          NEAR mandate revoke blocks new MPC signing. It does not erase an
          already-exported ECDSA signature on Sepolia.
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Ledger ownership</h3>
          <span className="badge badge-warn">{GATE_G_ACCOUNTING.ledger.label}</span>
        </div>
        <p>{GATE_G_ACCOUNTING.ledger.note}</p>
        <p className="muted small">
          Software FullAccess keys remaining:{" "}
          {GATE_G_ACCOUNTING.ledger.softwareFullAccessRemaining}
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

      <section className="card">
        <h3>Claims we do not make</h3>
        <ul>
          <li>Tidepool maker signatures verified on-chain</li>
          <li>Revoke cancels already-exportable EVM transactions</li>
          <li>Ledger-only ownership (still BLOCKED)</li>
          <li>Production 1Click equivalence to Tidepool sandbox</li>
        </ul>
      </section>
    </div>
  );
}
