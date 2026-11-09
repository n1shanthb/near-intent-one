import { useEffect, useState } from "react";
import { CONFIG } from "../lib/config";
import { loadMandateViews } from "../lib/near";
import { fetchDryQuote, type DryQuote } from "../lib/tidepool";
import {
  agentStatusFromRecorded,
  F4_EXECUTION,
  FROZEN_POLICY,
  GATE_G_ACCOUNTING,
  PORTFOLIO_RECORDED,
} from "../data/evidenceSnapshot";
import { ExecutionFlow } from "./ExecutionFlow";
import { gateHLedger } from "../adapters/gateh";

export function Overview({ mode }: { mode: "verified" | "simulation" | "live" }) {
  const [mandate, setMandate] = useState<Awaited<
    ReturnType<typeof loadMandateViews>
  > | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [quote, setQuote] = useState<DryQuote | null>(null);
  const [ledgerLive, setLedgerLive] = useState(false);

  useEffect(() => {
    void gateHLedger.isProven().then(setLedgerLive);
  }, []);

  useEffect(() => {
    if (mode !== "live") return;
    let cancelled = false;
    (async () => {
      try {
        const m = await loadMandateViews();
        if (!cancelled) setMandate(m);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode]);

  const recordedStatus = agentStatusFromRecorded();
  const liveStatus = (() => {
    if (!mandate) return null;
    if (mandate.revoked?.revoked) return "revoked";
    if ((mandate.exposure?.unresolved_pending ?? 0) > 0) return "settling";
    return "ready";
  })();

  const agentStatus = mode === "live" && liveStatus ? liveStatus : recordedStatus;

  return (
    <div className="stack">
      <ExecutionFlow />

      <div className="metric-row">
        <Metric
          label="Agent"
          value={agentStatus}
          hint={
            mode === "verified"
              ? "Recorded: idle/ready after F4 SUCCESS + G settle"
              : "Live RPC status when available"
          }
          tone={agentStatus === "ready" || agentStatus === "idle" ? "ok" : "warn"}
        />
        <Metric
          label="Reserved exposure"
          value={
            mode === "live" && mandate?.exposure
              ? String(mandate.exposure.reserved_pending_exposure)
              : GATE_G_ACCOUNTING.snapshot.reserved_pending_exposure
          }
          hint="Gate G recorded = 0"
          tone="ok"
        />
        <Metric
          label="Economically settled"
          value={
            mode === "live" && mandate?.exposure?.economically_settled != null
              ? String(mandate.exposure.economically_settled)
              : String(GATE_G_ACCOUNTING.snapshot.economically_settled)
          }
          hint={`Unresolved pending: ${GATE_G_ACCOUNTING.snapshot.unresolved_pending}`}
          tone="ok"
        />
        <Metric
          label="Ledger"
          value={
            ledgerLive
              ? "PROVEN"
              : GATE_G_ACCOUNTING.ledger.label
          }
          hint="Gate H required for hardware PASS"
          tone="warn"
        />
      </div>

      <div className="cards-2">
        <article className="card">
          <div className="card-head">
            <h3>Portfolio</h3>
            <span className="badge badge-recorded">RECORDED VERIFIED</span>
          </div>
          <p className="muted small">
            {PORTFOLIO_RECORDED.label} · as of {PORTFOLIO_RECORDED.asOf}
          </p>
          <p className="muted small">{PORTFOLIO_RECORDED.note}</p>
          {PORTFOLIO_RECORDED.chains.map((c) => (
            <div key={c.chain} className="chain-block">
              <h4>{c.chain}</h4>
              <ul>
                {c.tokens.map((t) => (
                  <li key={t.symbol}>
                    <strong>{t.symbol}</strong> {t.balance}
                    <span className="muted"> — {t.note}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p className="mono small">MPC EVM {PORTFOLIO_RECORDED.mpcEvm}</p>
        </article>

        <article className="card">
          <div className="card-head">
            <h3>Risk & mandate</h3>
            <span className="badge badge-recorded">GATE G SNAPSHOT</span>
          </div>
          <dl className="kv">
            <dt>Epoch</dt>
            <dd>{GATE_G_ACCOUNTING.snapshot.mandate_epoch}</dd>
            <dt>Revoked</dt>
            <dd>{String(GATE_G_ACCOUNTING.snapshot.revoked)}</dd>
            <dt>Max trade</dt>
            <dd>{FROZEN_POLICY.max_trade_value} base units</dd>
            <dt>Slippage</dt>
            <dd>{FROZEN_POLICY.max_slippage_bps} bps</dd>
            <dt>Reconciler</dt>
            <dd className="mono">{GATE_G_ACCOUNTING.reconciler}</dd>
            <dt>Evidence verify</dt>
            <dd>off-chain only (verified_onchain=false)</dd>
          </dl>
          {mode === "live" && (
            <>
              <button
                type="button"
                className="ghost"
                onClick={async () => {
                  setErr(null);
                  try {
                    setQuote(await fetchDryQuote());
                  } catch (e) {
                    setErr(e instanceof Error ? e.message : String(e));
                  }
                }}
              >
                Live dry quote
              </button>
              {err && <p className="err">{err}</p>}
              {quote && (
                <p className="small muted">
                  CURRENT LIVE READ · out {quote.quote?.amountOut ?? "—"}
                </p>
              )}
              {mandate && (
                <p className="small muted">
                  CURRENT LIVE READ · reserved{" "}
                  {mandate.exposure?.reserved_pending_exposure ?? "—"} · path{" "}
                  <span className="mono">{mandate.path ?? CONFIG.policyContract}</span>
                </p>
              )}
            </>
          )}
        </article>
      </div>

      <article className="card feature-card">
        <div className="card-head">
          <h3>Latest unattended trade (F4)</h3>
          <span className="badge badge-pass">PASS · SETTLED</span>
        </div>
        <p>
          {F4_EXECUTION.amountInDisplay} · Tidepool {F4_EXECUTION.tidepoolStatus} ·
          policy epoch {F4_EXECUTION.policyEpoch} unchanged
        </p>
        <div className="proof-links">
          <a
            href={`${CONFIG.etherscan}/tx/${F4_EXECUTION.sepoliaTx}`}
            target="_blank"
            rel="noreferrer"
          >
            Sepolia deposit
          </a>
          <a
            href={`${CONFIG.nearblocks}/txns/${F4_EXECUTION.nearSettlementTxs[0]}`}
            target="_blank"
            rel="noreferrer"
          >
            NEAR settlement
          </a>
          <a
            href={`${CONFIG.nearblocks}/txns/${F4_EXECUTION.mpcSignTx}`}
            target="_blank"
            rel="noreferrer"
          >
            MPC signature
          </a>
        </div>
        <p className="muted small">
          Trust model: {F4_EXECUTION.trustModel}. Not actively settling — cycle
          completed and reconciled.
        </p>
      </article>
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone: "ok" | "warn" | "danger";
}) {
  return (
    <div className={`metric-tile tone-${tone}`}>
      <span className="metric-label">{label}</span>
      <strong className="metric-value">{value}</strong>
      <span className="metric-hint">{hint}</span>
    </div>
  );
}
