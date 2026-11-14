import { useEffect, useState } from "react";
import {
  fetchMainnetAgent,
  fetchMainnetDecisions,
  fetchMainnetMandate,
  fetchMainnetTransactions,
  usdcLabel,
  chainBadge,
  type MainnetMandate,
  type MainnetDecisionSummary,
} from "../../adapters/mainnetPublic";
import type { NavId } from "./nav";

export function AgentInspectorPage({
  onNav,
  accountSlug = "nishanthb.near",
}: {
  onNav: (id: NavId) => void;
  accountSlug?: string;
}) {
  const [mandate, setMandate] = useState<MainnetMandate | null>(null);
  const [agent, setAgent] = useState<Record<string, unknown> | null>(null);
  const [decisions, setDecisions] = useState<MainnetDecisionSummary[]>([]);
  const [txs, setTxs] = useState<Awaited<ReturnType<typeof fetchMainnetTransactions>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [m, a, d, t] = await Promise.all([
          fetchMainnetMandate(),
          fetchMainnetAgent(),
          fetchMainnetDecisions(20),
          fetchMainnetTransactions(),
        ]);
        if (cancelled) return;
        setMandate(m);
        setAgent(a);
        setDecisions(d.decisions || []);
        setTxs(t);
      } catch (e) {
        if (!cancelled) setError(String((e as Error).message || e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const last = decisions[0];
  const identities = (agent?.identities || {}) as Record<string, string>;

  return (
    <section className="axis-panel">
      <div className="axis-panel-heading">
        <h2>Public agent inspector</h2>
        <p className="axis-supporting mono">/inspect/{accountSlug}</p>
      </div>

      {error && <p className="axis-supporting">Live fetch error: {error}</p>}

      <div className="nio-inspect-grid">
        <div>
          <h3>Identities</h3>
          <ul className="nio-kv mono">
            <li>Owner: {identities.owner || mandate?.owner || "nishanthb.near"}</li>
            <li>Agent: {identities.agent || mandate?.agent || "agent.nishanthb.near"}</li>
            <li>Policy: {identities.policy || mandate?.policy || "policy.nishanthb.near"}</li>
            <li>
              Portfolio:{" "}
              {identities.portfolio_id || mandate?.portfolio_id || "nio-mainnet-v1"}
            </li>
          </ul>
        </div>

        <div>
          <h3>Permissions</h3>
          {mandate?.ok ? (
            <>
              <p>
                Epoch {mandate.mandate_epoch} ·{" "}
                {mandate.paused ? "PAUSED" : "LIVE"} ·{" "}
                {mandate.autonomous_trading ? "AUTONOMOUS" : "OFF"} · enforce=
                {String(mandate.enforce_autonomous_on_agent)}
              </p>
              <p>
                Max trade {usdcLabel(mandate.limits.max_trade_value)} · Daily{" "}
                {usdcLabel(mandate.limits.daily_turnover_limit)} · Pending cap{" "}
                {usdcLabel(mandate.limits.max_pending_exposure)} · Slippage{" "}
                {mandate.limits.max_slippage_bps} bps
              </p>
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
              <p className="axis-supporting">
                PERMITTED BY POLICY — not the same as VERIFIED EXECUTION
              </p>
            </>
          ) : (
            <p className="axis-supporting">Loading mandate…</p>
          )}
        </div>
      </div>

      <h3>Last decision</h3>
      {last ? (
        <ul className="nio-kv">
          <li className="mono">{last.cycle_id}</li>
          <li>
            {last.final_action} · Fitter {last.fitter_verdict} · {last.reason_code}
          </li>
          <li>Status {last.status}</li>
          {last.explorer && (
            <li>
              <a href={last.explorer} target="_blank" rel="noreferrer">
                Nearblocks audit receipt
              </a>
            </li>
          )}
        </ul>
      ) : (
        <p className="axis-supporting">
          No decision audit records indexed yet (OFFCHAIN_ONLY until audit method
          deployed + keeper anchors).
        </p>
      )}

      <h3>Provenance</h3>
      <ul className="nio-tx-list">
        {(txs?.governance || []).map((g) => (
          <li key={g.tx}>
            {g.kind}:{" "}
            <a href={g.explorer} target="_blank" rel="noreferrer" className="mono">
              {g.tx}
            </a>
          </li>
        ))}
      </ul>

      <div className="nio-inspect-actions">
        <button type="button" className="axis-btn" onClick={() => onNav("verify")}>
          Proof &amp; Verify
        </button>
        <button type="button" className="axis-btn" onClick={() => onNav("agent")}>
          AI Agent
        </button>
        <button type="button" className="axis-btn" onClick={() => onNav("mandate")}>
          Mandate
        </button>
      </div>
    </section>
  );
}
