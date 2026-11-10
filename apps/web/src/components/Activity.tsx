import { CONFIG } from "../lib/config";
import {
  ADVERSARIAL_DEMOS,
  F4_EXECUTION,
  GATE_G_ACCOUNTING,
  H3_EXECUTION,
  HARDWARE_OWNERSHIP,
} from "../data/evidenceSnapshot";
import { RECEIPTS } from "../data/receipts";
import {
  RECORDED_TRADE_PASS,
  RECORDED_WITHDRAW_RECEIVED,
  RECORDED_WITHDRAW_SIGNED,
} from "../lib/withdrawLifecycle";
import { useProductSession } from "../state/ProductSession";
import { GateIBanner } from "./GateIBanner";

export function Activity() {
  const { portfolio, gateI, authMode } = useProductSession();

  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h3>Current live state</h3>
          <span className="badge badge-warn">LIVE GATE I</span>
        </div>
        <GateIBanner />
        <dl className="kv dense">
          <dt>Connected auth</dt>
          <dd>{authMode ?? "unset"}</dd>
          <dt>Gate I</dt>
          <dd>{gateI.status}</dd>
          <dt>Portfolio</dt>
          <dd className="mono">{portfolio?.portfolio_id ?? "none"}</dd>
          <dt>Owner</dt>
          <dd className="mono">{portfolio?.owner_account ?? "—"}</dd>
          <dt>Policy</dt>
          <dd className="mono">{portfolio?.policy_contract ?? "—"}</dd>
          <dt>MPC / Intents</dt>
          <dd className="mono">{portfolio?.intents_signer_id ?? "—"}</dd>
        </dl>
        <p className="muted small">
          Ordinary-wallet Gate I owners are independent of the historic Ledger demo
          proof on <span className="mono">{CONFIG.policyContract}</span>.
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Recorded Gate F–I evidence</h3>
          <span className="badge badge-recorded">NOT CURRENT RUNTIME</span>
        </div>
        <p className="muted">
          Early NEAR auth{" "}
          <a href={RECORDED_WITHDRAW_SIGNED.explorer} target="_blank" rel="noreferrer">
            {RECORDED_WITHDRAW_SIGNED.near_tx.slice(0, 14)}…
          </a>{" "}
          = Signed. Closure PASS Sepolia withdraw{" "}
          <a href={RECORDED_WITHDRAW_RECEIVED.explorer} target="_blank" rel="noreferrer">
            {RECORDED_WITHDRAW_RECEIVED.sepolia_tx.slice(0, 14)}…
          </a>{" "}
          = <strong>Received</strong> ({RECORDED_WITHDRAW_RECEIVED.amount}). Trade{" "}
          <a href={RECORDED_TRADE_PASS.explorer} target="_blank" rel="noreferrer">
            {RECORDED_TRADE_PASS.sepolia_tx.slice(0, 14)}…
          </a>{" "}
          Tidepool SUCCESS. Demo <span className="mono">nio-c-*</span> untouched.
        </p>
      </section>

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
          <h3>H1 Ledger proofs (demo custody)</h3>
          <span className="badge badge-pass">OWNERSHIP VERIFIED</span>
        </div>
        <p className="muted small">
          Historic hardware demo — separate from new ordinary-wallet Gate I owners.
        </p>
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
        <div className="card-head">
          <h3>Illustrative Predict</h3>
          <span className="badge badge-warn">SIMULATION — NOT VERIFIED P/L</span>
        </div>
        <p className="muted">
          Open Predict from the sidebar for scenario charts. Never treated as live
          Gate I settlement.
        </p>
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
