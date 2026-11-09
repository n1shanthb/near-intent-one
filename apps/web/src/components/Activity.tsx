import { CONFIG } from "../lib/config";
import {
  ADVERSARIAL_DEMOS,
  F4_EXECUTION,
  GATE_G_ACCOUNTING,
  H3_EXECUTION,
  HARDWARE_OWNERSHIP,
} from "../data/evidenceSnapshot";
import { RECEIPTS } from "../data/receipts";

export function Activity() {
  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h3>H3 strategy settle</h3>
          <span className="badge badge-recorded">RECORDED VERIFIED</span>
        </div>
        <div className="proof-links">
          <a
            href={`${CONFIG.etherscan}/tx/${H3_EXECUTION.sepoliaTx}`}
            target="_blank"
            rel="noreferrer"
          >
            Sepolia 0xba28b97b…
          </a>
          <a
            href={`${CONFIG.nearblocks}/txns/${H3_EXECUTION.mpcSignTx}`}
            target="_blank"
            rel="noreferrer"
          >
            MPC CGbXc3cH…
          </a>
          <a
            href={`${CONFIG.nearblocks}/txns/${H3_EXECUTION.reconcileTx}`}
            target="_blank"
            rel="noreferrer"
          >
            Reconcile CFj1Q12D…
          </a>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>F4 unattended settle</h3>
          <span className="badge badge-pass">PASS</span>
        </div>
        <div className="timeline-v">
          {F4_EXECUTION.steps.map((s, i) => (
            <div key={s.id} className="tl-item">
              <div className="tl-rail">
                <span className="tl-dot" />
                {i < F4_EXECUTION.steps.length - 1 && <span className="tl-line" />}
              </div>
              <div className="tl-body">
                <strong>{s.label}</strong>
                <p className="muted">{s.detail}</p>
                {s.href && (
                  <a href={s.href} target="_blank" rel="noreferrer">
                    Explorer proof
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>H1 Ledger proofs</h3>
          <span className="badge badge-pass">OWNERSHIP VERIFIED</span>
        </div>
        <div className="proof-links">
          <a
            href={`${CONFIG.nearblocks}/txns/${HARDWARE_OWNERSHIP.setPolicyTx}`}
            target="_blank"
            rel="noreferrer"
          >
            set_policy
          </a>
          <a
            href={`${CONFIG.nearblocks}/txns/${HARDWARE_OWNERSHIP.revokeTx}`}
            target="_blank"
            rel="noreferrer"
          >
            revoke
          </a>
          <a
            href={`${CONFIG.nearblocks}/txns/${HARDWARE_OWNERSHIP.removeOwnerSoftwareTx}`}
            target="_blank"
            rel="noreferrer"
          >
            remove owner software
          </a>
          <a
            href={`${CONFIG.nearblocks}/txns/${HARDWARE_OWNERSHIP.removePolicySoftwareTx}`}
            target="_blank"
            rel="noreferrer"
          >
            remove policy software
          </a>
        </div>
      </section>

      <section className="card">
        <h3>Adversarial rejects</h3>
        <ul className="demo-list">
          {ADVERSARIAL_DEMOS.map((d) => (
            <li key={d.id}>
              <div className="row between">
                <strong>{d.title}</strong>
                <span className="badge badge-danger">{d.result}</span>
              </div>
              <p className="muted">{d.detail}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h3>Gate G accounting snapshot</h3>
        <pre className="code">
          {JSON.stringify(GATE_G_ACCOUNTING.snapshot, null, 2)}
        </pre>
      </section>

      <section className="card">
        <h3>Gate index</h3>
        <div className="receipt-grid">
          {RECEIPTS.map((r) => (
            <div key={r.id} className="receipt">
              <header className="row between">
                <span className="eyebrow">Gate {r.gate}</span>
                <span className={`badge badge-${r.result.toLowerCase()}`}>
                  {r.result}
                </span>
              </header>
              <strong>{r.title}</strong>
              <p className="muted small">{r.summary}</p>
              {r.links.map((l) => (
                <div key={l.href}>
                  <a href={l.href} target="_blank" rel="noreferrer">
                    {l.label}
                  </a>
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
