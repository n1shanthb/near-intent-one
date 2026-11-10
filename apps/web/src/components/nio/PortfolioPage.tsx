import { useEffect, useState } from "react";
import { useNearWallet } from "near-connect-hooks";
import { getPortfolio, listBalances } from "../../adapters/gatei";
import { GATE_K_FIRST_TRADE } from "../../data/gateKEvidence";
import { useProductSession } from "../../state/ProductSession";
import { Portfolio } from "../Portfolio";
import type { NavId } from "./nav";
import type { BalanceSlice, PortfolioRecord } from "../../types/gateI";

const DEMO_ID = "i-a-a4e7";

export function PortfolioPage({ onNav }: { onNav: (id: NavId) => void }) {
  const { gateI } = useProductSession();
  const { signedAccountId } = useNearWallet();
  const [demo, setDemo] = useState<PortfolioRecord | null>(null);
  const [balances, setBalances] = useState<BalanceSlice[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showPersonal, setShowPersonal] = useState(false);

  useEffect(() => {
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
              : "Live balances temporarily unavailable — showing recorded Gate K figures."
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
  }, [gateI.status]);

  const recordedBefore = GATE_K_FIRST_TRADE.balance_before_usdc;
  const recordedAfter = GATE_K_FIRST_TRADE.balance_after_usdc;

  return (
    <div className="page-enter nio-portfolio-page">
      <div className="axis-intro">
        <div>
          <h1>Portfolio</h1>
          <p>
            Public demo balances and mandate context. Wallet connection is optional for
            evidence; personal portfolio creation stays owner-authorized.
          </p>
        </div>
      </div>

      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>Demo portfolio summary</h2>
          <span className="nio-badge nio-badge-recorded">PUBLIC DEMO</span>
        </div>
        <div className="axis-stats" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}>
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
          <div className="axis-stat">
            <span>Max spend (Gate K)</span>
            <strong style={{ fontSize: 22 }}>{GATE_K_FIRST_TRADE.max_spend_usdc}</strong>
          </div>
        </div>
        {loadError ? <p className="axis-supporting">{loadError}</p> : null}
        <p className="axis-supporting mono" style={{ marginTop: 10 }}>
          Technical id · {DEMO_ID}
          {demo?.policy_contract ? ` · ${demo.policy_contract}` : ""}
        </p>
      </section>

      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>Available assets</h2>
        </div>
        {balances.length ? (
          <div className="axis-table-wrap">
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
        ) : (
          <div className="nio-empty-state">
            <p>
              Live balance slice unavailable. Recorded Gate K residual:{" "}
              <strong>{recordedAfter} USDC</strong> on Sepolia testnet after the
              disclosed override execution.
            </p>
          </div>
        )}
      </section>

      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>Mandate limits</h2>
        </div>
        <dl className="nio-kv">
          <div>
            <dt>Network</dt>
            <dd>NEAR testnet · Sepolia execution</dd>
          </div>
          <div>
            <dt>Autonomous trading</dt>
            <dd>
              <span className="nio-badge nio-badge-danger">OFF</span>
            </dd>
          </div>
          <div>
            <dt>Gate K max spend</dt>
            <dd>{GATE_K_FIRST_TRADE.max_spend_usdc} USDC</dd>
          </div>
          <div>
            <dt>Policy epoch</dt>
            <dd className="mono">{GATE_K_FIRST_TRADE.mandate.epoch}</dd>
          </div>
        </dl>
      </section>

      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>Recent activity</h2>
          <button type="button" className="axis-inline-link" onClick={() => onNav("evidence")}>
            Open evidence
          </button>
        </div>
        <div className="axis-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Result</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Gate K AI-directed trade</td>
                <td>
                  <span className="nio-badge nio-badge-warn">OVERRIDE</span>
                </td>
                <td>{GATE_K_FIRST_TRADE.proposed_usdc} USDC</td>
              </tr>
              <tr>
                <td>Live AI dry-run</td>
                <td>
                  <span className="nio-badge nio-badge-recorded">NO SIGNING</span>
                </td>
                <td>—</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>Personal portfolio</h2>
          <span className="nio-badge nio-badge-idle">OWNER SESSION</span>
        </div>
        <p className="axis-supporting">
          Personal portfolio management requires an authenticated owner session and is
          unavailable as a public mutation surface.{" "}
          {signedAccountId
            ? `Connected as ${signedAccountId}.`
            : "Connect a wallet only if you intend to manage your own testnet portfolio."}
        </p>
        <button
          type="button"
          className="axis-button secondary"
          onClick={() => setShowPersonal((v) => !v)}
        >
          {showPersonal ? "Hide personal controls" : "Show personal controls"}
        </button>
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
