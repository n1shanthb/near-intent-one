import { useEffect, useState } from "react";
import { useNearWallet } from "near-connect-hooks";
import { getPortfolio, listBalances } from "../../adapters/gatei";
import { usdcLabel, chainBadge } from "../../adapters/mainnetPublic";
import { GATE_K_FIRST_TRADE } from "../../data/gateKEvidence";
import { useProductSession } from "../../state/ProductSession";
import {
  formatLastUpdated,
  useWorkspace,
} from "../../state/WorkspaceContext";
import { LiveDataChrome } from "./WorkspaceSwitcher";
import { Portfolio } from "../Portfolio";
import { FourChainPortfolioPanel } from "./FourChainPortfolioPanel";
import type { NavId } from "./nav";
import type { BalanceSlice, PortfolioRecord } from "../../types/gateI";

const DEMO_ID = "i-a-a4e7";

export function PortfolioPage({ onNav }: { onNav: (id: NavId) => void }) {
  const { gateI } = useProductSession();
  const { signedAccountId } = useNearWallet();
  const {
    isPublic,
    identities,
    live,
    personalProvisioned,
    setMode,
  } = useWorkspace();
  const [demo, setDemo] = useState<PortfolioRecord | null>(null);
  const [balances, setBalances] = useState<BalanceSlice[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showPersonal, setShowPersonal] = useState(false);

  useEffect(() => {
    if (isPublic) return;
    let cancelled = false;
    void (async () => {
      try {
        const p = await getPortfolio(DEMO_ID);
        const b = await listBalances(DEMO_ID);
        if (cancelled) return;
        setDemo(p);
        setBalances(b);
        if (!p) {
          setLoadError(
            gateI.status === "available"
              ? "Demo portfolio could not be loaded."
              : "Live balances temporarily unavailable."
          );
        } else {
          setLoadError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gateI.status, isPublic]);

  const mandate = live.mandate;
  const recordedBefore = GATE_K_FIRST_TRADE.balance_before_usdc;
  const recordedAfter = GATE_K_FIRST_TRADE.balance_after_usdc;

  if (isPublic) {
    return (
      <div className="page-enter nio-portfolio-page">
        <div className="axis-intro">
          <div>
            <h1>Portfolio</h1>
            <p>
              Verified mainnet balances for{" "}
              <span className="mono">{identities.portfolio_id}</span>. Unavailable
              slices stay marked unavailable — never Sepolia demo amounts.
            </p>
          </div>
          <LiveDataChrome />
        </div>

        <FourChainPortfolioPanel />

        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>Mainnet identities</h2>
            <span className="nio-badge nio-badge-success">MAINNET</span>
          </div>
          <dl className="nio-kv">
            <div>
              <dt>Owner</dt>
              <dd className="mono">{identities.owner}</dd>
            </div>
            <div>
              <dt>Agent</dt>
              <dd className="mono">{identities.agent}</dd>
            </div>
            <div>
              <dt>Policy</dt>
              <dd className="mono">{identities.policy}</dd>
            </div>
            <div>
              <dt>Portfolio</dt>
              <dd className="mono">{identities.portfolio_id}</dd>
            </div>
          </dl>
        </section>

        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>Verified balances</h2>
            <span className="nio-badge nio-badge-idle">
              {live.balances?.ok ? "LIVE READ" : "PENDING"}
            </span>
          </div>
          {live.balances?.rows?.length ? (
            <div className="axis-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Role</th>
                    <th>Account</th>
                    <th>Chain</th>
                    <th>Asset</th>
                    <th>Amount</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {live.balances.rows.map((row) => (
                    <tr key={`${row.role}-${row.chain}-${row.asset}`}>
                      <td>{row.role}</td>
                      <td className="mono">{row.account}</td>
                      <td>{row.chain}</td>
                      <td>{row.asset}</td>
                      <td className="mono">
                        {row.status === "verified" && row.amount != null
                          ? row.amount
                          : "—"}
                      </td>
                      <td>
                        <span
                          className={`nio-badge ${
                            row.status === "verified"
                              ? "nio-badge-success"
                              : "nio-badge-idle"
                          }`}
                        >
                          {row.status === "verified" ? "VERIFIED" : "UNAVAILABLE"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="nio-empty-state">
              <p>
                Balance endpoint unavailable
                {live.error ? ` (${live.error})` : ""}. Amounts are not substituted
                with testnet demo figures.
              </p>
            </div>
          )}
          <p className="axis-supporting" style={{ marginTop: 10 }}>
            {live.balances?.note ??
              "Updated " + formatLastUpdated(live.lastUpdated)}
          </p>
        </section>

        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>Mandate limits (live)</h2>
          </div>
          {mandate?.ok ? (
            <dl className="nio-kv">
              <div>
                <dt>Network</dt>
                <dd>NEAR mainnet</dd>
              </div>
              <div>
                <dt>Autonomous trading</dt>
                <dd>
                  <span
                    className={`nio-badge ${
                      mandate.autonomous_trading
                        ? "nio-badge-success"
                        : "nio-badge-danger"
                    }`}
                  >
                    {mandate.autonomous_trading ? "ON" : "OFF"}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Max trade</dt>
                <dd>{usdcLabel(mandate.limits.max_trade_value)}</dd>
              </div>
              <div>
                <dt>Daily / pending</dt>
                <dd>
                  {usdcLabel(mandate.limits.daily_turnover_limit)} ·{" "}
                  {usdcLabel(mandate.limits.max_pending_exposure)}
                </dd>
              </div>
              <div>
                <dt>Chains (permitted by policy)</dt>
                <dd>
                  <div className="nio-chain-badges">
                    {(mandate.limits.allowed_chains || []).map((c) => {
                      const b = chainBadge(c);
                      return (
                        <span key={c} className={`nio-badge nio-badge-${b.tone}`}>
                          {b.label}
                        </span>
                      );
                    })}
                  </div>
                </dd>
              </div>
              <div>
                <dt>Policy epoch</dt>
                <dd className="mono">{mandate.mandate_epoch}</dd>
              </div>
            </dl>
          ) : (
            <p className="axis-supporting">
              Live mandate unavailable
              {live.error ? `: ${live.error}` : "."}
            </p>
          )}
        </section>

        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>Historical testnet evidence</h2>
            <span className="nio-badge nio-badge-recorded">TESTNET · NOT MAINNET</span>
          </div>
          <p className="axis-supporting">
            Gate K residual {recordedAfter} USDC (before {recordedBefore}) on Sepolia
            is historical lab evidence only.
          </p>
          <button
            type="button"
            className="axis-button secondary"
            onClick={() => onNav("evidence")}
          >
            Open historical evidence
          </button>
        </section>
      </div>
    );
  }

  return (
    <div className="page-enter nio-portfolio-page">
      <div className="axis-intro">
        <div>
          <h1>Portfolio</h1>
          <p>
            Personal workspace.{" "}
            {personalProvisioned
              ? `Showing portfolio ${identities.portfolio_id}.`
              : "No personal portfolio provisioned — empty setup state, not Nishanth's data."}
          </p>
        </div>
        <button
          type="button"
          className="axis-button secondary"
          onClick={() => setMode("nishanth_public")}
        >
          View Nishanth&apos;s agent
        </button>
      </div>

      {!personalProvisioned ? (
        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>Setup required</h2>
            <span className="nio-badge nio-badge-warn">NOT PROVISIONED</span>
          </div>
          <p>
            Authenticate as owner, then create your portfolio through supported
            workflows. Public visitors cannot sign as Nishanth&apos;s agent.
          </p>
          <div className="axis-actions">
            <button
              type="button"
              className="axis-button"
              onClick={() => onNav("owner")}
            >
              Owner auth
            </button>
            <button
              type="button"
              className="axis-button secondary"
              onClick={() => onNav("my-portfolio")}
            >
              My Portfolio
            </button>
          </div>
        </section>
      ) : null}

      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>Historical testnet lab (optional)</h2>
          <span className="nio-badge nio-badge-recorded">PUBLIC DEMO · TESTNET</span>
        </div>
        <div
          className="axis-stats"
          style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}
        >
          <div className="axis-stat">
            <span>API</span>
            <strong style={{ fontSize: 22 }}>
              {gateI.status === "available" ? "Connected" : "Recorded mode"}
            </strong>
          </div>
          <div className="axis-stat">
            <span>USDC after Gate K</span>
            <strong style={{ fontSize: 22 }}>{recordedAfter}</strong>
          </div>
          <div className="axis-stat">
            <span>USDC before Gate K</span>
            <strong style={{ fontSize: 22 }}>{recordedBefore}</strong>
          </div>
        </div>
        {loadError ? <p className="axis-supporting">{loadError}</p> : null}
        <p className="axis-supporting mono" style={{ marginTop: 10 }}>
          Technical id · {DEMO_ID}
          {demo?.policy_contract ? ` · ${demo.policy_contract}` : ""}
        </p>
        {balances.length ? (
          <div className="axis-table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Chain</th>
                  <th>Balance</th>
                </tr>
              </thead>
              <tbody>
                {balances.map((b, i) => (
                  <tr key={`${b.asset ?? i}-${i}`}>
                    <td className="mono">{b.asset ?? "—"}</td>
                    <td>{b.chain ?? "—"}</td>
                    <td className="mono">{b.amount ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>Personal portfolio</h2>
          <span className="nio-badge nio-badge-idle">LEDGER OWNER</span>
        </div>
        <p className="axis-supporting">
          Personal data requires a physical Ledger NEP-413 owner session.{" "}
          {signedAccountId
            ? `Optional software wallet connected as ${signedAccountId} (not owner proof).`
            : "Use Owner auth to connect Ledger and verify ownership."}
        </p>
        <div className="axis-actions" style={{ flexWrap: "wrap" }}>
          <button
            type="button"
            className="axis-button"
            onClick={() => onNav("owner")}
          >
            Connect Ledger → Verify
          </button>
          <button
            type="button"
            className="axis-button secondary"
            onClick={() => onNav("my-portfolio")}
          >
            Open My Portfolio
          </button>
          <button
            type="button"
            className="axis-button secondary"
            onClick={() => setShowPersonal((v) => !v)}
          >
            {showPersonal ? "Hide legacy controls" : "Show legacy controls"}
          </button>
        </div>
        {showPersonal ? (
          <div className="legacy-embed" style={{ marginTop: 16 }}>
            <Portfolio
              onNav={(id) =>
                onNav(
                  id === "funds"
                    ? "funds"
                    : id === "policies"
                      ? "mandate"
                      : id === "agent"
                        ? "agent"
                        : "overview"
                )
              }
            />
          </div>
        ) : null}
      </section>
    </div>
  );
}
