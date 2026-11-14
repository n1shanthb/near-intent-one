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
import {
  usdcLabel,
  chainBadge,
  safeText,
  safeNumber,
  flagLabel,
} from "../../adapters/mainnetPublic";
import {
  formatLastUpdated,
  useWorkspace,
} from "../../state/WorkspaceContext";
import { useOwnerSession } from "../../state/OwnerSession";
import { NetworkStatusPanel } from "./NetworkIndicator";
import { LiveDataChrome } from "./WorkspaceSwitcher";
import { OnboardingJourney } from "./OnboardingJourney";

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
  const { verified, session } = useOwnerSession();
  const {
    isPublic,
    identities,
    live,
    personalProvisioned,
    setMode,
  } = useWorkspace();
  const network = workspaceNetworkContext(
    isPublic ? "mainnet" : healthNetwork
  );
  const mainnetReady = hasVerifiedMainnetContract();
  const mandate = live.mandate;
  const latest = live.decisions[0] ?? null;

  if (!isPublic) {
    return (
      <div className="page-enter axis-overview">
        <section className="axis-overview-hero">
          <div className="axis-overview-hero-copy">
            <div className="axis-overview-hero-label">
              <Bot size={16} /> Personal workspace
            </div>
            <h1>Set up your own agent</h1>
            <p>
              Connect and verify ownership to provision a personal portfolio.
              This workspace never inherits Nishanth&apos;s mainnet balances or
              permissions.
            </p>
            <div className="axis-actions">
              <button
                type="button"
                className="axis-button axis-overview-explore"
                onClick={() => onNav(verified ? "my-portfolio" : "owner")}
              >
                {verified ? "Open My Portfolio" : "Owner auth"}
                <ArrowUpRight size={16} />
              </button>
              <button
                type="button"
                className="axis-button secondary"
                onClick={() => setMode("nishanth_public")}
              >
                View Nishanth&apos;s agent
              </button>
            </div>
          </div>
          <div className="axis-overview-catalog">
            <div className="axis-overview-catalog-label">Personal status</div>
            <dl>
              <div>
                <dt>Owner</dt>
                <dd style={{ fontSize: 18 }}>
                  {session?.account_id ?? "Not verified"}
                </dd>
              </div>
              <div>
                <dt>Portfolio</dt>
                <dd style={{ fontSize: 18 }}>
                  {personalProvisioned
                    ? identities.portfolio_id
                    : "Not provisioned"}
                </dd>
              </div>
              <div>
                <dt>API</dt>
                <dd style={{ fontSize: 18 }}>
                  {gateIStatus === "available" ? "Connected" : "Unreachable"}
                </dd>
              </div>
              <div>
                <dt>Demo AI</dt>
                <dd style={{ fontSize: 18 }}>{demoLabel}</dd>
              </div>
            </dl>
            <div className="axis-overview-catalog-note">
              {personalProvisioned
                ? gateIDetail
                : "Honest empty state — no substitute showcase data."}
            </div>
          </div>
        </section>
        <OnboardingJourney
          compact
          input={{
            walletConnected: verified,
            ownerVerified: verified,
            ownerAccountId: session?.account_id,
            network: network.active,
            evidence: MAINNET_EVIDENCE,
          }}
          onNav={onNav}
        />
      </div>
    );
  }

  return (
    <div className="page-enter axis-overview">
      <section className="axis-overview-hero">
        <div className="axis-overview-hero-copy">
          <div className="axis-overview-hero-label">
            <Bot size={16} /> NIO Mainnet Command Center · {network.label}
          </div>
          <h1>Hardware sets rules. AI decides. NEAR enforces.</h1>
          <p>
            Live read-only view of{" "}
            <span className="mono">{identities.policy}</span> — mandate, AI
            decisions, and on-chain audit proofs. No wallet required.
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
              onClick={() => onNav("verify")}
            >
              Proof &amp; Verify
            </button>
          </div>
          <div style={{ marginTop: 12 }}>
            <LiveDataChrome />
          </div>
        </div>
        <div className="axis-overview-catalog">
          <div className="axis-overview-catalog-label">Live mainnet status</div>
          <dl>
            <div>
              <dt>Owner</dt>
              <dd style={{ fontSize: 16 }} className="mono">
                {safeText(mandate?.owner, identities.owner ?? "—")}
              </dd>
            </div>
            <div>
              <dt>Epoch</dt>
              <dd style={{ fontSize: 22 }}>
                {safeText(
                  safeNumber(mandate?.mandate_epoch, MAINNET_EVIDENCE.policy.epoch),
                  "—"
                )}
              </dd>
            </div>
            <div>
              <dt>Autonomous</dt>
              <dd style={{ fontSize: 18 }}>
                {mandate
                  ? flagLabel(mandate.autonomous_trading)
                  : live.status === "loading"
                    ? "…"
                    : "UNKNOWN"}
              </dd>
            </div>
            <div>
              <dt>Latest decision</dt>
              <dd style={{ fontSize: 16 }}>
                {latest ? (
                  <>
                    <span className="nio-badge nio-badge-danger">
                      {latest.final_action}
                    </span>{" "}
                    <span className="nio-badge nio-badge-idle">
                      {latest.status}
                    </span>
                  </>
                ) : (
                  "—"
                )}
              </dd>
            </div>
          </dl>
          <div className="axis-overview-catalog-note">
            Updated {formatLastUpdated(live.lastUpdated)}
            {live.error ? ` · ${live.error}` : ""} · polling every ~20s while visible
          </div>
        </div>
      </section>

      <section
        className={`axis-panel nio-mainnet-proof-banner ${
          mainnetReady ? "is-ready" : "is-pending"
        }`}
      >
        <div className="axis-panel-heading">
          <h2>Mainnet agent</h2>
          <span
            className={`nio-badge ${
              mainnetReady ? "nio-badge-success" : "nio-badge-warn"
            }`}
          >
            {mainnetReady ? "VERIFIED ON-CHAIN" : "PENDING"}
          </span>
        </div>
        <p>
          Owner <span className="mono">{identities.owner}</span> · Agent{" "}
          <span className="mono">{identities.agent}</span> · Policy{" "}
          <span className="mono">{identities.policy}</span> · Portfolio{" "}
          <span className="mono">{identities.portfolio_id}</span>
        </p>
        {mandate?.ok ? (
          <div
            className="axis-stats"
            style={{
              gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))",
              marginTop: 12,
            }}
          >
            <div className="axis-stat">
              <span>Max trade</span>
              <strong style={{ fontSize: 18 }}>
                {usdcLabel(mandate.limits.max_trade_value)}
              </strong>
            </div>
            <div className="axis-stat">
              <span>Daily turnover</span>
              <strong style={{ fontSize: 18 }}>
                {usdcLabel(mandate.limits.daily_turnover_limit)}
              </strong>
            </div>
            <div className="axis-stat">
              <span>Pending exposure</span>
              <strong style={{ fontSize: 18 }}>
                {usdcLabel(mandate.limits.max_pending_exposure)}
              </strong>
            </div>
            <div className="axis-stat">
              <span>state_version</span>
              <strong style={{ fontSize: 18 }}>
                {safeText(mandate.state_version)}
              </strong>
            </div>
          </div>
        ) : null}
        {mandate?.ok ? (
          <div className="nio-chain-badges" style={{ marginTop: 12 }}>
            {(mandate.limits.allowed_chains || []).map((c) => {
              const b = chainBadge(c);
              return (
                <span key={c} className={`nio-badge nio-badge-${b.tone}`}>
                  {b.label} · permitted
                </span>
              );
            })}
          </div>
        ) : null}
        <div className="axis-actions" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="axis-button"
            onClick={() => onNav("mandate")}
          >
            <FileText size={16} /> Live mandate
          </button>
          <button
            type="button"
            className="axis-button secondary"
            onClick={() => onNav("mainnet")}
          >
            <Globe2 size={16} /> Mainnet evidence
          </button>
        </div>
      </section>

      <NetworkStatusPanel ctx={network} />

      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>Deposit safety</h2>
          <span className="nio-badge nio-badge-danger">BLOCKED</span>
        </div>
        <p className="warn">
          Mainnet deposits are not enabled for visitors. Do not send funds.
        </p>
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
            <small>Verified mainnet balances</small>
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
            <small>Live autonomous decisions</small>
          </span>
          <ArrowUpRight />
        </button>
        <button
          type="button"
          className="axis-overview-action"
          onClick={() => onNav("verify")}
        >
          <span className="axis-overview-action-icon">
            <Shield size={20} />
          </span>
          <span>
            <b>Proof &amp; Verify</b>
            <small>On-chain audit trail</small>
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
            <h2>Latest audit</h2>
            <button
              type="button"
              className="axis-inline-link"
              onClick={() => onNav("verify")}
            >
              Verify <ArrowUpRight size={14} />
            </button>
          </div>
          {latest ? (
            <>
              <p>
                <span className="nio-badge nio-badge-danger">
                  {latest.final_action}
                </span>{" "}
                <span className="nio-badge nio-badge-warn">
                  FITTER {latest.fitter_verdict}
                </span>{" "}
                <span className="nio-badge nio-badge-idle">
                  CRITIC {latest.critic_verdict}
                </span>
              </p>
              <p className="axis-supporting mono">
                {latest.reason_code} · epoch {latest.mandate_epoch} ·{" "}
                {latest.status}
              </p>
              {latest.explorer ? (
                <a
                  className="axis-button secondary"
                  href={latest.explorer}
                  target="_blank"
                  rel="noreferrer"
                >
                  Audit tx
                </a>
              ) : null}
            </>
          ) : (
            <p className="axis-supporting">
              Waiting for OCI-indexed decision cycles…
            </p>
          )}
        </section>
        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>Historical testnet evidence</h2>
            <button
              type="button"
              className="axis-inline-link"
              onClick={() => onNav("evidence")}
            >
              Open <ArrowUpRight size={14} />
            </button>
          </div>
          <p>
            Gate K Sepolia ({GATE_K_FIRST_TRADE.proposed_usdc} USDC) is{" "}
            <strong>historical testnet</strong> — not mainnet activity.
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
            <FileText size={16} /> Sepolia explorer
          </a>
        </section>
      </div>
    </div>
  );
}
