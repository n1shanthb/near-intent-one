import { useEffect, useMemo, useState } from "react";
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
import {
  EmptyState,
  EvidenceTimeline,
  IdentityRow,
  MetricCard,
  StatusBadge,
  explainReasonCode,
  governanceTitle,
} from "./uiPrimitives";

const AUDIT_RECEIPT = "CXR4ey3x2x3scEhGeW8sRLnRAVsPrsYiRYFPcTAAAz1s";
const AUDIT_EXPLORER = `https://nearblocks.io/txns/${AUDIT_RECEIPT}`;

type PartialErr = { source: string; message: string };

function autonomyTone(v: boolean | null | undefined) {
  if (v === true) return "success" as const;
  if (v === false) return "danger" as const;
  return "idle" as const;
}

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
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);

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

      if (m.status === "fulfilled" && m.value?.ok) setMandate(m.value);
      else {
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
      } else if (a.status === "rejected") {
        errs.push({
          source: "agent",
          message: String((a.reason as Error)?.message || a.reason),
        });
      }

      if (d.status === "fulfilled") setDecisions(d.value.decisions || []);
      else {
        errs.push({
          source: "decisions",
          message: String((d.reason as Error)?.message || d.reason),
        });
        setDecisions([]);
      }

      if (t.status === "fulfilled" && t.value) setTxs(t.value);
      else if (t.status === "rejected") {
        errs.push({
          source: "transactions",
          message: String((t.reason as Error)?.message || t.reason),
        });
      }

      setPartialErrors(errs);
      setFetchedAt(new Date().toLocaleTimeString());
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountSlug]);

  const last = decisions[0] ?? null;
  const identities = (agent?.identities || {}) as Record<string, string>;
  const owner = identities.owner || mandate?.owner || "nishanthb.near";
  const agentId = identities.agent || mandate?.agent || "agent.nishanthb.near";
  const policy = identities.policy || mandate?.policy || "policy.nishanthb.near";
  const portfolio =
    identities.portfolio_id || mandate?.portfolio_id || "nio-mainnet-v1";

  const provenanceItems = useMemo(() => {
    const gov = txs?.governance || [];
    if (gov.length) {
      return gov.map((g) => ({
        id: g.tx,
        title: governanceTitle(g.kind),
        hash: g.tx,
        href: g.explorer,
      }));
    }
    return [
      {
        id: AUDIT_RECEIPT,
        title: "NO_TRADE audit receipt",
        hash: AUDIT_RECEIPT,
        href: AUDIT_EXPLORER,
      },
    ];
  }, [txs]);

  const verifyHref =
    last?.explorer ||
    (last?.near_tx ? `https://nearblocks.io/txns/${last.near_tx}` : AUDIT_EXPLORER);

  return (
    <div className="page-enter nio-page-shell nio-inspect-page">
      <header className="nio-page-header">
        <div>
          <div className="nio-page-kicker">
            <StatusBadge tone="success">NEAR Mainnet</StatusBadge>
            <StatusBadge tone={autonomyTone(mandate?.autonomous_trading ?? null)}>
              {`Autonomous ${flagLabel(mandate?.autonomous_trading ?? null)}`}
            </StatusBadge>
          </div>
          <h1>Nishanth&apos;s AI Agent</h1>
          <p>
            Public read-only inspector for{" "}
            <span className="mono">{agentId}</span>
            {fetchedAt ? ` · Updated ${fetchedAt}` : ""}
          </p>
        </div>
        <div className="axis-actions">
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
            onClick={() => onNav("mandate")}
          >
            Mandate
          </button>
        </div>
      </header>

      {loading ? (
        <div className="nio-skeleton-stack" aria-busy="true">
          <div className="nio-skeleton" />
          <div className="nio-skeleton" />
          <div className="nio-skeleton short" />
        </div>
      ) : null}

      {partialErrors.length > 0 ? (
        <div className="nio-disclosure">
          Partial API failure — page remains usable.{" "}
          {partialErrors.map((e) => `${e.source}: ${e.message}`).join(" · ")}
        </div>
      ) : null}

      <div
        className="axis-stats nio-metric-row"
        style={{ gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))" }}
      >
        <MetricCard
          label="Max trade"
          value={usdcLabel(mandate?.limits.max_trade_value)}
        />
        <MetricCard
          label="Daily limit"
          value={usdcLabel(mandate?.limits.daily_turnover_limit)}
        />
        <MetricCard
          label="Pending cap"
          value={usdcLabel(mandate?.limits.max_pending_exposure)}
        />
        <MetricCard
          label="Mandate epoch"
          value={safeText(mandate?.mandate_epoch)}
          hint={
            mandate?.limits.max_slippage_bps != null
              ? `${mandate.limits.max_slippage_bps} bps slippage`
              : undefined
          }
        />
      </div>

      <section className="axis-panel nio-featured-card">
        <div className="axis-panel-heading">
          <h2>Latest decision</h2>
          {last ? (
            <StatusBadge
              tone={
                last.status === "ONCHAIN_VERIFIED"
                  ? "success"
                  : last.final_action === "TRADE"
                    ? "warn"
                    : "idle"
              }
            >
              {last.status}
            </StatusBadge>
          ) : (
            <StatusBadge tone="idle">PENDING</StatusBadge>
          )}
        </div>

        {last ? (
          <>
            <p className="nio-decision-action">{last.final_action}</p>
            <p className="nio-decision-summary">
              Fitter <strong>{last.fitter_verdict}</strong>
              {last.critic_verdict ? (
                <>
                  {" "}
                  · Critic <strong>{last.critic_verdict}</strong>
                </>
              ) : null}
            </p>
            <p>{explainReasonCode(last.reason_code)}</p>
            <p className="axis-supporting">
              {last.timestamp_ms
                ? new Date(last.timestamp_ms).toLocaleString()
                : "Timestamp unavailable"}{" "}
              · cycle{" "}
              <span className="mono">
                {last.cycle_id.length > 28
                  ? `${last.cycle_id.slice(0, 20)}…`
                  : last.cycle_id}
              </span>
            </p>
            <div className="axis-actions" style={{ marginTop: 12 }}>
              <a
                className="axis-button"
                href={verifyHref}
                target="_blank"
                rel="noreferrer"
              >
                Verify on NEAR
              </a>
              <button
                type="button"
                className="axis-button secondary"
                onClick={() => onNav("verify")}
              >
                Open Proof &amp; Verify
              </button>
            </div>
          </>
        ) : (
          <EmptyState
            title="No live decision records indexed yet"
            detail="The verified NO_TRADE audit receipt remains independently checkable under Governance proofs."
            action={
              <a
                className="axis-button"
                href={AUDIT_EXPLORER}
                target="_blank"
                rel="noreferrer"
              >
                Verify on NEAR
              </a>
            }
          />
        )}
      </section>

      <div className="nio-two-col">
        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>Identities</h2>
          </div>
          <div className="nio-identity-stack">
            <IdentityRow label="Owner" value={owner} />
            <IdentityRow label="Agent" value={agentId} />
            <IdentityRow label="Policy" value={policy} />
            <IdentityRow label="Portfolio" value={portfolio} />
          </div>
        </section>

        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>Permissions</h2>
            <StatusBadge tone={mandate?.paused === true ? "warn" : "running"}>
              {flagLabel(mandate?.paused ?? null, "PAUSED", "LIVE")}
            </StatusBadge>
          </div>
          {mandate?.ok ? (
            <>
              <div className="nio-identity-stack">
                <IdentityRow
                  label="Enforce on agent"
                  value={flagLabel(mandate.enforce_autonomous_on_agent)}
                  mono={false}
                />
                <IdentityRow
                  label="Revoked"
                  value={flagLabel(mandate.revoked, "REVOKED", "NOT_REVOKED")}
                  mono={false}
                />
                <IdentityRow
                  label="Slippage"
                  value={
                    mandate.limits.max_slippage_bps != null
                      ? `${mandate.limits.max_slippage_bps} bps`
                      : "—"
                  }
                  mono={false}
                />
              </div>
              <div className="nio-chain-badges" style={{ marginTop: 12 }}>
                {(mandate.limits.allowed_chains || []).map((c) => {
                  const b = chainBadge(c);
                  return (
                    <span key={c} className={`nio-badge nio-badge-${b.tone}`}>
                      {b.label}
                    </span>
                  );
                })}
              </div>
              <p className="axis-supporting" style={{ marginTop: 10 }}>
                Chains are permitted by policy — not verified execution.
              </p>
            </>
          ) : (
            <p className="axis-supporting">
              {loading ? "Loading mandate…" : "Mandate temporarily unavailable."}
            </p>
          )}
        </section>
      </div>

      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>Governance proofs</h2>
          <StatusBadge tone="recorded">MAINNET</StatusBadge>
        </div>
        <EvidenceTimeline items={provenanceItems} collapsedCount={4} />
      </section>
    </div>
  );
}
