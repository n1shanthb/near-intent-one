import {
  ArrowUpRight,
  Bot,
  FileText,
  Shield,
  WalletCards,
} from "lucide-react";
import type { NavId } from "./nav";
import { GATE_K_FIRST_TRADE } from "../../data/gateKEvidence";

export function OverviewPage({
  onNav,
  gateIStatus,
  demoLabel,
}: {
  onNav: (id: NavId) => void;
  gateIStatus: string;
  demoLabel: string;
}) {
  return (
    <div className="page-enter axis-overview">
      <section className="axis-overview-hero">
        <div className="axis-overview-hero-copy">
          <div className="axis-overview-hero-label">
            <Bot size={16} /> NIO workspace · NEAR testnet
          </div>
          <h1>Hardware sets rules. AI decides. NEAR enforces.</h1>
          <p>
            Browse portfolio evidence without a wallet. Run a public Live AI
            dry-run when quotas allow. Signing and Gate K execution stay off.
          </p>
          <button
            type="button"
            className="axis-button axis-overview-explore"
            onClick={() => onNav("agent")}
          >
            Open AI Agent
            <ArrowUpRight size={16} />
          </button>
        </div>
        <div className="axis-overview-catalog">
          <div className="axis-overview-catalog-label">Live status</div>
          <dl>
            <div>
              <dt>Gate I API</dt>
              <dd style={{ fontSize: 22 }}>{gateIStatus}</dd>
            </div>
            <div>
              <dt>Live AI demo</dt>
              <dd style={{ fontSize: 22 }}>{demoLabel}</dd>
            </div>
          </dl>
          <div className="axis-overview-catalog-note">
            Portfolio demo id · i-a-a4e7 · may_sign forced false
          </div>
        </div>
      </section>

      <div className="axis-overview-actions">
        <button
          type="button"
          className="axis-overview-action"
          onClick={() => onNav("portfolio")}
        >
          <span className="axis-overview-action-icon">
            <WalletCards size={20} />
          </span>
          <span>
            <b>Portfolio</b>
            <small>Balances & limits</small>
          </span>
          <ArrowUpRight />
        </button>
        <button
          type="button"
          className="axis-overview-action build"
          onClick={() => onNav("agent")}
        >
          <span className="axis-overview-action-icon">
            <Bot size={20} />
          </span>
          <span>
            <b>AI Agent</b>
            <small>Live dry-run console</small>
          </span>
          <ArrowUpRight />
        </button>
        <button
          type="button"
          className="axis-overview-action browse"
          onClick={() => onNav("security")}
        >
          <span className="axis-overview-action-icon">
            <Shield size={20} />
          </span>
          <span>
            <b>Security</b>
            <small>Mandate & Ledger</small>
          </span>
          <ArrowUpRight />
        </button>
      </div>

      <div className="axis-overview-collections">
        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>Owner mandate</h2>
            <button
              type="button"
              className="axis-inline-link"
              onClick={() => onNav("mandate")}
            >
              Inspect <ArrowUpRight size={14} />
            </button>
          </div>
          <p>
            Demo portfolio <span className="mono">i-a-a4e7</span> hydrates
            on-chain mandate for Live AI. Public UI cannot mutate policy.
          </p>
          <div className="axis-stats" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <div className="axis-stat">
              <span>Network</span>
              <strong style={{ fontSize: 22 }}>testnet</strong>
            </div>
            <div className="axis-stat">
              <span>Signing</span>
              <strong style={{ fontSize: 22 }}>dry-run</strong>
            </div>
          </div>
        </section>
        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>Gate K evidence</h2>
            <button
              type="button"
              className="axis-inline-link"
              onClick={() => onNav("evidence")}
            >
              Open <ArrowUpRight size={14} />
            </button>
          </div>
          <p>
            {GATE_K_FIRST_TRADE.labels.live_ai_execution}.{" "}
            {GATE_K_FIRST_TRADE.labels.autonomous_safety}.
          </p>
          <p className="axis-supporting mono">
            Sepolia {GATE_K_FIRST_TRADE.execution.sepolia_tx.slice(0, 18)}…
          </p>
          <a
            className="axis-button secondary"
            href={GATE_K_FIRST_TRADE.execution.sepolia_explorer}
            target="_blank"
            rel="noreferrer"
          >
            <FileText size={16} /> Explorer
          </a>
        </section>
      </div>
    </div>
  );
}
