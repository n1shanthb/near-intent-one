import { useState } from "react";
import { GATE_K_FIRST_TRADE, NEARBLOCKS_TX } from "../../data/gateKEvidence";
import { H3_EXECUTION } from "../../data/evidenceSnapshot";
import {
  RECORDED_TRADE_PASS,
  RECORDED_WITHDRAW_RECEIVED,
} from "../../lib/withdrawLifecycle";
import { CONFIG } from "../../lib/config";

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    /* ignore */
  }
}

function HashRow({
  label,
  value,
  href,
}: {
  label: string;
  value: string;
  href?: string;
}) {
  const short =
    value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
  return (
    <div className="nio-hash-row">
      <span>{label}</span>
      <code className="mono">{short}</code>
      <div className="nio-hash-actions">
        <button type="button" className="axis-button secondary" onClick={() => void copyText(value)}>
          Copy
        </button>
        {href ? (
          <a className="axis-button secondary" href={href} target="_blank" rel="noreferrer">
            Explorer
          </a>
        ) : null}
      </div>
    </div>
  );
}

export function EvidencePage() {
  const k = GATE_K_FIRST_TRADE;
  const [showRaw, setShowRaw] = useState(false);

  return (
    <div className="page-enter nio-evidence-page">
      <div className="axis-intro">
        <div>
          <h1>Evidence</h1>
          <p>Gate K — Real AI-directed Sepolia execution and historical proofs.</p>
        </div>
      </div>

      <section className="axis-panel nio-evidence-hero">
        <div className="axis-panel-heading">
          <h2>Gate K — Real AI-directed Sepolia execution</h2>
          <span className="nio-badge nio-badge-warn">OPERATOR OVERRIDE DISCLOSED</span>
        </div>
        <div className="axis-stats" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))" }}>
          <div className="axis-stat">
            <span>Amount</span>
            <strong style={{ fontSize: 24 }}>{k.proposed_usdc} USDC</strong>
          </div>
          <div className="axis-stat">
            <span>Network</span>
            <strong style={{ fontSize: 24 }}>Sepolia</strong>
          </div>
          <div className="axis-stat">
            <span>Settlement</span>
            <strong style={{ fontSize: 24 }}>{k.execution.tidepool_status}</strong>
          </div>
          <div className="axis-stat">
            <span>Reconcile</span>
            <strong style={{ fontSize: 24 }}>{k.execution.reconcile_status}</strong>
          </div>
        </div>
        <div className="nio-disclosure" role="note">
          <strong>Important limitation.</strong> Fitter returned ECONOMIC_NOT_VIABLE.
          Critic returned REJECT. Pipeline decision was NO_TRADE. Execution happened only
          after an explicitly authorized one-time operator acceptance override — not
          normal autonomous safety-approved execution.
        </div>
      </section>

      <div className="nio-evidence-grid">
        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>AI decision</h2>
          </div>
          <dl className="nio-kv">
            <div>
              <dt>Researcher</dt>
              <dd className="mono">{k.models.researcher}</dd>
            </div>
            <div>
              <dt>Strategist</dt>
              <dd>
                <span className="nio-badge nio-badge-success">{k.ai.strategist_choice}</span>{" "}
                {k.proposed_usdc} USDC
              </dd>
            </div>
            <div>
              <dt>Fitter</dt>
              <dd>
                <span className="nio-badge nio-badge-danger">{k.ai.fitter_outcome}</span>{" "}
                {k.ai.fitter_reasons.join(", ")}
              </dd>
            </div>
            <div>
              <dt>Critic</dt>
              <dd>
                <span className="nio-badge nio-badge-danger">{k.ai.critic_verdict}</span>
              </dd>
            </div>
            <div>
              <dt>Normal pipeline</dt>
              <dd>
                <span className="nio-badge nio-badge-danger">{k.ai.pipeline_decision}</span>
              </dd>
            </div>
          </dl>
        </section>

        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>On-chain execution</h2>
          </div>
          <HashRow
            label="NEAR propose"
            value={k.execution.near_propose_tx}
            href={`${NEARBLOCKS_TX}/${k.execution.near_propose_tx}`}
          />
          <HashRow
            label="NEAR MPC sign"
            value={k.execution.near_sign_tx}
            href={`${NEARBLOCKS_TX}/${k.execution.near_sign_tx}`}
          />
          <HashRow
            label="Sepolia tx"
            value={k.execution.sepolia_tx}
            href={k.execution.sepolia_explorer}
          />
          <p className="axis-supporting mono">
            Receipt status {k.execution.sepolia_status} · op {k.execution.operation_id}
          </p>
        </section>

        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>Settlement</h2>
          </div>
          <dl className="nio-kv">
            <div>
              <dt>Tidepool</dt>
              <dd>
                <span className="nio-badge nio-badge-success">{k.execution.tidepool_status}</span>
              </dd>
            </div>
            <div>
              <dt>Reconciler</dt>
              <dd>
                <span className="nio-badge nio-badge-success">{k.execution.reconcile_status}</span>
              </dd>
            </div>
            <div>
              <dt>Reconcile actor</dt>
              <dd className="mono">{k.execution.reconcile_actor}</dd>
            </div>
            <div>
              <dt>Authorized at</dt>
              <dd className="mono">{k.authorized_at}</dd>
            </div>
          </dl>
          <HashRow
            label="Reconcile tx"
            value={k.execution.reconcile_tx}
            href={`${NEARBLOCKS_TX}/${k.execution.reconcile_tx}`}
          />
        </section>
      </div>

      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>Historical proofs</h2>
          <span className="nio-badge nio-badge-recorded">RECORDED</span>
        </div>
        <div className="axis-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Proof</th>
                <th>Result</th>
                <th>Link</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Gate K Sepolia</td>
                <td>SUCCESS · override disclosed</td>
                <td>
                  <a href={k.execution.sepolia_explorer} target="_blank" rel="noreferrer">
                    Etherscan
                  </a>
                </td>
              </tr>
              <tr>
                <td>H3 settle</td>
                <td>Recorded</td>
                <td>
                  <a
                    href={`${CONFIG.etherscan}/tx/${H3_EXECUTION.sepoliaTx}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Sepolia
                  </a>
                </td>
              </tr>
              <tr>
                <td>Withdraw Received</td>
                <td>{RECORDED_WITHDRAW_RECEIVED.amount}</td>
                <td>
                  <a href={RECORDED_WITHDRAW_RECEIVED.explorer} target="_blank" rel="noreferrer">
                    Explorer
                  </a>
                </td>
              </tr>
              <tr>
                <td>Trade PASS</td>
                <td>Tidepool SUCCESS</td>
                <td>
                  <a href={RECORDED_TRADE_PASS.explorer} target="_blank" rel="noreferrer">
                    Explorer
                  </a>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <button
          type="button"
          className="axis-button secondary"
          style={{ marginTop: 12 }}
          onClick={() => setShowRaw((v) => !v)}
        >
          {showRaw ? "Hide technical summary" : "Show technical summary"}
        </button>
        {showRaw ? (
          <pre className="nio-code-block mono">
            {JSON.stringify(
              {
                portfolio_id: k.portfolio_id,
                mandate: k.mandate,
                acceptance_override: k.acceptance_override,
                labels: k.labels,
              },
              null,
              2
            )}
          </pre>
        ) : null}
      </section>
    </div>
  );
}
