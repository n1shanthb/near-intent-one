import {
  ArrowUpRight,
  Bot,
  FileText,
  Globe2,
  Shield,
  WalletCards,
} from "lucide-react";
import type { NavId } from "./nav";
import { GATE_K_FIRST_TRADE } from "../../data/gateKEvidence";
import {
  MAINNET_EVIDENCE,
  hasVerifiedMainnetContract,
} from "../../data/mainnetEvidence";
import { workspaceNetworkContext } from "../../lib/network";
import { NetworkStatusPanel } from "./NetworkIndicator";

export function OverviewPage({
  onNav,
  gateIStatus,
  gateIDetail,
  demoLabel,
  healthNetwork,
}: {
  onNav: (id: NavId) => void;
  gateIStatus: string;
  gateIDetail: string;
  demoLabel: string;
  healthNetwork?: string | null;
}) {
  const apiOk = gateIStatus === "available";
  const network = workspaceNetworkContext(healthNetwork);
  const mainnetReady = hasVerifiedMainnetContract();

  return (
    <div className="page-enter axis-overview">
      <section className="axis-overview-hero">
        <div className="axis-overview-hero-copy">
          <div className="axis-overview-hero-label">
            <Bot size={16} /> NIO workspace · {network.label}
          </div>
          <h1>Hardware sets rules. AI decides. NEAR enforces.</h1>
          <p>
            Browse portfolio evidence without a wallet. Run a public Live AI dry-run when
            quotas allow. Signing and Gate K execution stay off.
          </p>
          <div className="axis-actions">
            <button
              type="button"
              className="axis-button axis-overview-explore"
              onClick={() => onNav("agent")}
            >
              Open AI Agent
              <ArrowUpRight size={16} />
            </button>
            <button
              type="button"
              className="axis-button secondary"
              onClick={() => onNav("evidence")}
            >
              View Verified Execution
            </button>
          </div>
        </div>
        <div className="axis-overview-catalog">
          <div className="axis-overview-catalog-label">Live status</div>
          <dl>
            <div>
              <dt>API</dt>
              <dd style={{ fontSize: 22 }}>{apiOk ? "Connected" : "Unreachable"}</dd>
            </div>
            <div>
              <dt>Network</dt>
              <dd style={{ fontSize: 22 }}>{network.label}</dd>
            </div>
            <div>
              <dt>Live AI demo</dt>
              <dd style={{ fontSize: 22 }}>{demoLabel}</dd>
            </div>
            <div>
              <dt>Mainnet proof</dt>
              <dd style={{ fontSize: 22 }}>
                {mainnetReady ? "Verified" : "Pending"}
              </dd>
            </div>
          </dl>
          <div className="axis-overview-catalog-note">{gateIDetail}</div>
        </div>
      </section>

      <section
        className={`axis-panel nio-mainnet-proof-banner ${
          mainnetReady ? "is-ready" : "is-pending"
        }`}
      >
        <div className="axis-panel-heading">
          <h2>Mainnet proof</h2>
          <span
            className={`nio-badge ${
              mainnetReady ? "nio-badge-success" : "nio-badge-warn"
            }`}
          >
            {mainnetReady ? "VERIFIED ON-CHAIN" : "AWAITING CHAT 1"}
          </span>
        </div>
        {mainnetReady ? (
          <p>
            Independently verified NIO mainnet contract{" "}
            <span className="mono">{MAINNET_EVIDENCE.contract.account_id}</span>.
            Open Mainnet evidence for deploy tx, policy, MPC, and Intents status.
          </p>
        ) : (
          <p>
            No independently verified NIO mainnet deployment is displayed yet.
            Capability chips stay honest (all NO) until Chat 1 supplies on-chain
            proof. Testnet Gate K evidence remains separate.
          </p>
        )}
        <div className="axis-actions" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="axis-button"
            onClick={() => onNav("mainnet")}
          >
            <Globe2 size={16} /> Open Mainnet evidence
          </button>
          <button
            type="button"
            className="axis-button secondary"
            onClick={() => onNav("evidence")}
          >
            Testnet Gate K proof
          </button>
        </div>
      </section>

      <NetworkStatusPanel ctx={network} />

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
            <b>Demo portfolio</b>
            <small>Public balances & limits</small>
          </span>
          <ArrowUpRight />
        </button>
        <button
          type="button"
          className="axis-overview-action"
          onClick={() => onNav("owner")}
        >
          <span className="axis-overview-action-icon">
            <Shield size={20} />
          </span>
          <span>
            <b>Owner auth</b>
            <small>Ledger → verify → My Portfolio</small>
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
            Live AI hydrates the demo on-chain mandate. Public UI cannot mutate policy.
          </p>
          <div className="axis-stats" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <div className="axis-stat">
              <span>Network</span>
              <strong style={{ fontSize: 22 }}>{network.active}</strong>
            </div>
            <div className="axis-stat">
              <span>Signing</span>
              <strong style={{ fontSize: 22 }}>dry-run</strong>
            </div>
          </div>
          <p className="axis-supporting mono" style={{ marginTop: 10 }}>
            Technical portfolio id · i-a-a4e7
          </p>
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
            {GATE_K_FIRST_TRADE.proposed_usdc} USDC Sepolia execution with operator-override
            disclosure. Not autonomous safety-approved.
          </p>
          <p className="axis-supporting mono">
            {GATE_K_FIRST_TRADE.execution.sepolia_tx.slice(0, 18)}…
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
