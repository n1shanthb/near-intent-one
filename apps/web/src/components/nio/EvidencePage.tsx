import { useState } from "react";
import { GATE_K_FIRST_TRADE, NEARBLOCKS_TX } from "../../data/gateKEvidence";
import { H3_EXECUTION } from "../../data/evidenceSnapshot";
import {
  RECORDED_TRADE_PASS,
  RECORDED_WITHDRAW_RECEIVED,
} from "../../lib/withdrawLifecycle";
import { CONFIG } from "../../lib/config";
import {
  MAINNET_EVIDENCE,
  hasVerifiedMainnetContract,
} from "../../data/mainnetEvidence";
import type { NavId } from "./nav";
import { HashWithActions, StatusBadge } from "./uiPrimitives";

export function EvidencePage({ onNav }: { onNav?: (id: NavId) => void }) {
  const k = GATE_K_FIRST_TRADE;
  const [showRaw, setShowRaw] = useState(false);
  const mainnetReady = hasVerifiedMainnetContract();

  return (
    <div className="page-enter nio-page-shell nio-evidence-page">
      <div className="axis-intro">
        <div>
          <h1>Evidence</h1>
          <p>
            Historical Gate K Sepolia execution and related proofs. Mainnet proof
            lives on a separate page and is never mixed with these receipts.
          </p>
        </div>
        <div className="nio-flag-row">
          <StatusBadge tone="warn">HISTORICAL</StatusBadge>
          <StatusBadge tone="recorded">TESTNET</StatusBadge>
          <StatusBadge tone="danger">SUPERVISED</StatusBadge>
        </div>
      </div>

      <section
        className={`axis-panel nio-mainnet-proof-banner ${
          mainnetReady ? "is-ready" : "is-pending"
        }`}
      >
        <div className="axis-panel-heading">
          <h2>Mainnet proof</h2>
          <StatusBadge tone={mainnetReady ? "success" : "warn"}>
            {mainnetReady ? "VERIFIED" : "PENDING"}
          </StatusBadge>
        </div>
        {mainnetReady ? (
          <p>
            Verified mainnet contract{" "}
            <span className="mono">{MAINNET_EVIDENCE.contract.account_id}</span>.
            Open the Mainnet evidence view for deploy tx, policy, MPC, and Intents.
          </p>
        ) : (
          <p>
            Independently verified NIO mainnet deployment details are not available
            yet. This Gate K panel remains Sepolia/testnet only.
          </p>
        )}
        {onNav ? (
          <div className="axis-actions" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="axis-button"
              onClick={() => onNav("mainnet")}
            >
              Open Mainnet evidence
            </button>
          </div>
        ) : null}
      </section>

      <section className="axis-panel nio-evidence-hero">
        <div className="axis-panel-heading">
          <h2>Gate K — Real AI-directed Sepolia execution</h2>
          <StatusBadge tone="warn">OPERATOR OVERRIDE DISCLOSED</StatusBadge>
        </div>
        <p className="axis-supporting" style={{ marginTop: 0, marginBottom: 12 }}>
          Network: <strong>Sepolia testnet</strong> · supervised · not mainnet
        </p>
        <div
          className="axis-stats nio-metric-row"
          style={{ gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))" }}
        >
          <div className="axis-stat nio-metric-card">
            <span>Amount</span>
            <strong>{k.proposed_usdc} USDC</strong>
          </div>
          <div className="axis-stat nio-metric-card">
            <span>Network</span>
            <strong>Sepolia</strong>
          </div>
          <div className="axis-stat nio-metric-card">
            <span>Settlement</span>
            <strong>{k.execution.tidepool_status}</strong>
          </div>
          <div className="axis-stat nio-metric-card">
            <span>Reconcile</span>
            <strong>{k.execution.reconcile_status}</strong>
          </div>
        </div>
        <div className="nio-disclosure" role="note">
          <strong>Important limitation.</strong> Fitter returned ECONOMIC_NOT_VIABLE.
          Critic returned REJECT. Pipeline decision was NO_TRADE. Execution happened
          only after an explicitly authorized one-time operator acceptance override —
          not normal autonomous safety-approved execution.
        </div>
      </section>

      <div className="nio-evidence-grid nio-evidence-grid-compact">
        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>AI decision</h2>
            <StatusBadge tone="recorded">TESTNET</StatusBadge>
          </div>
          <dl className="nio-kv">
            <div>
              <dt>Strategist</dt>
              <dd>
                <StatusBadge tone="success">{k.ai.strategist_choice}</StatusBadge>{" "}
                {k.proposed_usdc} USDC
              </dd>
            </div>
            <div>
              <dt>Fitter</dt>
              <dd>
                <StatusBadge tone="danger">{k.ai.fitter_outcome}</StatusBadge>{" "}
                {k.ai.fitter_reasons.join(", ")}
              </dd>
            </div>
            <div>
              <dt>Critic</dt>
              <dd>
                <StatusBadge tone="danger">{k.ai.critic_verdict}</StatusBadge>
              </dd>
            </div>
            <div>
              <dt>Normal pipeline</dt>
              <dd>
                <StatusBadge tone="danger">{k.ai.pipeline_decision}</StatusBadge>
              </dd>
            </div>
          </dl>
        </section>

        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>On-chain receipts</h2>
            <StatusBadge tone="warn">SUPERVISED</StatusBadge>
          </div>
          <HashWithActions
            label="NEAR propose"
            value={k.execution.near_propose_tx}
            href={`${NEARBLOCKS_TX}/${k.execution.near_propose_tx}`}
          />
          <HashWithActions
            label="NEAR MPC sign"
            value={k.execution.near_sign_tx}
            href={`${NEARBLOCKS_TX}/${k.execution.near_sign_tx}`}
          />
          <HashWithActions
            label="Sepolia tx"
            value={k.execution.sepolia_tx}
            href={k.execution.sepolia_explorer}
          />
          <HashWithActions
            label="Reconcile tx"
            value={k.execution.reconcile_tx}
            href={`${NEARBLOCKS_TX}/${k.execution.reconcile_tx}`}
          />
          <p className="axis-supporting" style={{ marginTop: 8 }}>
            Receipt status {k.execution.sepolia_status} · Tidepool{" "}
            {k.execution.tidepool_status}
          </p>
        </section>
      </div>

      <section className="axis-panel" style={{ marginTop: 16 }}>
        <div className="axis-panel-heading">
          <h2>Additional historical proofs</h2>
          <StatusBadge tone="recorded">HISTORICAL · TESTNET</StatusBadge>
        </div>
        <HashWithActions
          label="H3 settle"
          value={H3_EXECUTION.sepoliaTx}
          href={`${CONFIG.etherscan}/tx/${H3_EXECUTION.sepoliaTx}`}
        />
        <HashWithActions
          label="Withdraw received"
          value={RECORDED_WITHDRAW_RECEIVED.sepolia_tx}
          href={RECORDED_WITHDRAW_RECEIVED.explorer}
        />
        <HashWithActions
          label="Trade PASS"
          value={RECORDED_TRADE_PASS.sepolia_tx}
          href={RECORDED_TRADE_PASS.explorer}
        />
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
