import { CONFIG } from "../lib/config";
import {
  ADVERSARIAL_DEMOS,
  F4_EXECUTION,
  GATE_G_ACCOUNTING,
} from "../data/evidenceSnapshot";
import { RECEIPTS } from "../data/receipts";

export function Activity() {
  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h3>F4 execution timeline</h3>
          <span className="badge badge-recorded">RECORDED VERIFIED</span>
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
        <div className="proof-links">
          <a
            href={`${CONFIG.etherscan}/tx/${F4_EXECUTION.sepoliaTx}`}
            target="_blank"
            rel="noreferrer"
          >
            Sepolia 0xe49d5ff8…
          </a>
          <a
            href={`${CONFIG.nearblocks}/txns/${F4_EXECUTION.nearSettlementTxs[0]}`}
            target="_blank"
            rel="noreferrer"
          >
            NEAR B6uEASpp…
          </a>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Adversarial rejects</h3>
          <span className="badge badge-warn">SECURITY</span>
        </div>
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
        <div className="card-head">
          <h3>Gate G accounting</h3>
          <span className="badge badge-pass">RESERVED = 0</span>
        </div>
        <p className="muted small">As of {GATE_G_ACCOUNTING.asOf}</p>
        <pre className="code">
          {JSON.stringify(GATE_G_ACCOUNTING.snapshot, null, 2)}
        </pre>
      </section>

      <section className="card">
        <h3>Gate index (B–G)</h3>
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
            </div>
          ))}
          <div className="receipt">
            <header className="row between">
              <span className="eyebrow">Gate F4</span>
              <span className="badge badge-pass">PASS</span>
            </header>
            <strong>Unattended ORIGIN_CHAIN settle</strong>
            <p className="muted small">
              Sepolia 0xe49d5ff8… · Tidepool SUCCESS · NEAR B6uEASpp…
            </p>
          </div>
          <div className="receipt">
            <header className="row between">
              <span className="eyebrow">Gate G</span>
              <span className="badge badge-warn">BLOCKED (Ledger)</span>
            </header>
            <strong>Accounting PASS · Ledger NOT PROVEN</strong>
            <p className="muted small">
              reserved=0 · economically_settled=true · hardware pending Gate H
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
