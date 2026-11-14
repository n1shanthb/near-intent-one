import { useEffect, useState } from "react";
import {
  fetchMainnetAgent,
  fetchMainnetDecisions,
  fetchMainnetMandate,
  fetchMainnetTransactions,
  usdcLabel,
  chainBadge,
  flagLabel,
  safeText,
  type MainnetMandate,
  type MainnetDecisionSummary,
} from "../../adapters/mainnetPublic";
import type { NavId } from "./nav";

const AUDIT_RECEIPT =
  "CXR4ey3x2x3scEhGeW8sRLnRAVsPrsYiRYFPcTAAAz1s";
const AUDIT_EXPLORER = `https://nearblocks.io/txns/${AUDIT_RECEIPT}`;

type PartialErr = { source: string; message: string };

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
  const [txs, setTxs] = useState<Awaited<
    ReturnType<typeof fetchMainnetTransactions>
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [partialErrors, setPartialErrors] = useState<PartialErr[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setPartialErrors([]);
      const settled = await Promise.allSettled([
        fetchMainnetMandate(),
        fetchMainnetAgent(),
        fetchMainnetDecisions(20),
        fetchMainnetTransactions(),
      ]);
      if (cancelled) return;

      const errs: PartialErr[] = [];
      const [m, a, d, t] = settled;

      if (m.status === "fulfilled" && m.value?.ok) {
        setMandate(m.value);
      } else {
        errs.push({
          source: "mandate",
          message:
            m.status === "rejected"
              ? String((m.reason as Error)?.message || m.reason)
              : "unavailable",
        });
      }

      if (a.status === "fulfilled" && a.value) {
        setAgent(a.value as Record<string, unknown>);
      } else {
        errs.push({
          source: "agent",
          message:
            a.status === "rejected"
              ? String((a.reason as Error)?.message || a.reason)
              : "unavailable",
        });
      }

      if (d.status === "fulfilled") {
        setDecisions(d.value.decisions || []);
      } else {
        errs.push({
          source: "decisions",
          message: String((d.reason as Error)?.message || d.reason),
        });
        setDecisions([]);
      }

      if (t.status === "fulfilled" && t.value) {
        setTxs(t.value);
      } else {
        errs.push({
          source: "transactions",
          message:
            t.status === "rejected"
              ? String((t.reason as Error)?.message || t.reason)
              : "unavailable",
        });
      }

      setPartialErrors(errs);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountSlug]);

  const last = decisions[0] ?? null;
  const identities = (agent?.identities || {}) as Record<string, string>;
  const provenance = (agent?.provenance || {}) as Record<string, string>;
  const auditTx =
    provenance.no_trade_audit_tx ||
    txs?.governance?.find((g) => g.kind.includes("record_decision"))?.tx ||
    AUDIT_RECEIPT;

  return (
    <div className="page-enter nio-inspect-page">
      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>Public agent inspector</h2>
          <span className="nio-badge nio-badge-success">MAINNET</span>
        </div>
        <p className="axis-supporting mono">/inspect/{accountSlug}</p>

        {loading ? (
          <div className="nio-skeleton-stack" aria-busy="true">
            <div className="nio-skeleton" />
            <div className="nio-skeleton" />
            <div className="nio-skeleton short" />
          </div>
        ) : null}

        {partialErrors.length > 0 ? (
          <div className="nio-disclosure" style={{ marginTop: 8 }}>
            Partial API failure — page remains usable.{" "}
            {partialErrors.map((e) => `${e.source}: ${e.message}`).join(" · ")}
          </div>
        ) : null}

        <div className="nio-inspect-grid">
          <div>
            <h3>Identities</h3>
            <ul className="nio-kv mono">
              <li>
                Owner:{" "}
                {identities.owner || mandate?.owner || "nishanthb.near"}
              </li>
              <li>
                Agent:{" "}
                {identities.agent || mandate?.agent || "agent.nishanthb.near"}
              </li>
              <li>
                Policy:{" "}
                {identities.policy || mandate?.policy || "policy.nishanthb.near"}
              </li>
              <li>
                Portfolio:{" "}
                {identities.portfolio_id ||
                  mandate?.portfolio_id ||
                  "nio-mainnet-v1"}
              </li>
            </ul>
          </div>

          <div>
            <h3>Permissions</h3>
            {mandate?.ok ? (
              <>
                <p>
                  Epoch {safeText(mandate.mandate_epoch)} ·{" "}
                  {flagLabel(mandate.paused, "PAUSED", "LIVE")} · AUTONOMY{" "}
                  {flagLabel(mandate.autonomous_trading)} · enforce=
                  {flagLabel(mandate.enforce_autonomous_on_agent)}
                </p>
                <p>
                  Max trade {usdcLabel(mandate.limits.max_trade_value)} · Daily{" "}
                  {usdcLabel(mandate.limits.daily_turnover_limit)} · Pending{" "}
                  {usdcLabel(mandate.limits.max_pending_exposure)} · Slippage{" "}
                  {mandate.limits.max_slippage_bps != null
                    ? `${mandate.limits.max_slippage_bps} bps`
                    : "—"}
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
              <p className="axis-supporting">
                {loading
                  ? "Loading mandate…"
                  : "Mandate temporarily unavailable."}
              </p>
            )}
          </div>
        </div>

        <h3>Last decision</h3>
        {last ? (
          <ul className="nio-kv">
            <li className="mono">{last.cycle_id}</li>
            <li>
              {last.final_action} · Fitter {last.fitter_verdict} ·{" "}
              {last.reason_code}
            </li>
            <li>Status {last.status}</li>
            {last.explorer ? (
              <li>
                <a href={last.explorer} target="_blank" rel="noreferrer">
                  Nearblocks audit receipt
                </a>
              </li>
            ) : null}
          </ul>
        ) : (
          <p className="axis-supporting">
            No decision records in the live store yet. Verified NO_TRADE audit
            receipt remains independently checkable below.
          </p>
        )}

        <h3>Verified audit receipt</h3>
        <p className="axis-supporting">
          On-chain <code>record_decision_cycle</code> (NO_TRADE) for the public
          agent:
        </p>
        <p>
          <a
            href={
              auditTx === AUDIT_RECEIPT
                ? AUDIT_EXPLORER
                : `https://nearblocks.io/txns/${auditTx}`
            }
            target="_blank"
            rel="noreferrer"
            className="mono"
          >
            {auditTx}
          </a>
        </p>

        <h3>Provenance</h3>
        <ul className="nio-tx-list">
          {(txs?.governance || []).map((g) => (
            <li key={g.tx}>
              {g.kind}:{" "}
              <a
                href={g.explorer}
                target="_blank"
                rel="noreferrer"
                className="mono"
              >
                {g.tx}
              </a>
            </li>
          ))}
          {!txs?.governance?.length ? (
            <li>
              <a href={AUDIT_EXPLORER} target="_blank" rel="noreferrer" className="mono">
                {AUDIT_RECEIPT}
              </a>{" "}
              (static Nearblocks fallback)
            </li>
          ) : null}
        </ul>

        <div className="nio-inspect-actions">
          <button
            type="button"
            className="axis-button secondary"
            onClick={() => onNav("verify")}
          >
            Proof &amp; Verify
          </button>
          <button
            type="button"
            className="axis-button secondary"
            onClick={() => onNav("agent")}
          >
            AI Agent
          </button>
          <button
            type="button"
            className="axis-button secondary"
            onClick={() => onNav("mandate")}
          >
            Mandate
          </button>
        </div>
      </section>
    </div>
  );
}
