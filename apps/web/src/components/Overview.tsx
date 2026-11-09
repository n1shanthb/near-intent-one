import { useEffect, useState } from "react";
import { CONFIG } from "../lib/config";
import { loadMandateViews } from "../lib/near";
import { fetchDryQuote, type DryQuote } from "../lib/tidepool";
import { verifyHardwareOwnershipLive } from "../lib/accessKeys";
import {
  agentStatusFromRecorded,
  F4_EXECUTION,
  FROZEN_POLICY,
  GATE_G_ACCOUNTING,
  H3_EXECUTION,
  HARDWARE_OWNERSHIP,
  MANDATE_AFTER_H1,
  PORTFOLIO_RECORDED,
} from "../data/evidenceSnapshot";
import { ExecutionFlow } from "./ExecutionFlow";
import { gateHLedger } from "../adapters/gateh";
import { Onboarding } from "./Onboarding";
import type { NavId } from "./Shell";

export function Overview({
  mode,
  onNav,
  onSignIn,
  walletConnected,
}: {
  mode: "verified" | "simulation" | "live";
  onNav: (id: NavId) => void;
  onSignIn: () => void;
  walletConnected: boolean;
}) {
  const [mandate, setMandate] = useState<Awaited<
    ReturnType<typeof loadMandateViews>
  > | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [quote, setQuote] = useState<DryQuote | null>(null);
  const [deviceConnected, setDeviceConnected] = useState(false);
  const [liveKeys, setLiveKeys] = useState<string | null>(null);

  useEffect(() => {
    void gateHLedger.isConnected().then(setDeviceConnected);
  }, []);

  useEffect(() => {
    if (mode !== "live") return;
    let cancelled = false;
    (async () => {
      try {
        const [m, keys] = await Promise.all([
          loadMandateViews(),
          verifyHardwareOwnershipLive(),
        ]);
        if (!cancelled) {
          setMandate(m);
          setLiveKeys(keys.detail);
        }
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
      <Onboarding onNav={onNav} onSignIn={onSignIn} walletConnected={walletConnected} />
      <ExecutionFlow />

      <div className="metric-row">
        <Metric
          label="Agent (recorded end-state)"
          value={agentStatus}
          hint={
            MANDATE_AFTER_H1.revoked
              ? `Mandate revoked @ epoch ${MANDATE_AFTER_H1.mandate_epoch} after H1 proof`
              : "Ready"
          }
          tone={agentStatus === "revoked" ? "warn" : "ok"}
        />
        <Metric
          label="Hardware ownership"
          value="VERIFIED"
          hint={HARDWARE_OWNERSHIP.ledgerPublicKey.slice(0, 28) + "…"}
          tone="ok"
        />
        <Metric
          label="Ledger device"
          value={deviceConnected ? "CONNECTED" : "DISCONNECTED"}
          hint="Session ≠ ownership. Open Ledger setup to connect."
          tone={deviceConnected ? "ok" : "warn"}
        />
        <Metric
          label="Reserved (G snapshot)"
          value={GATE_G_ACCOUNTING.snapshot.reserved_pending_exposure}
          hint={`economically_settled=${GATE_G_ACCOUNTING.snapshot.economically_settled}`}
          tone="ok"
        />
      </div>

      <div className="cards-2">
        <article className="card">
          <div className="card-head">
            <h3>Portfolio</h3>
            <span className="badge badge-recorded">RECORDED VERIFIED</span>
          </div>
          <p className="muted small">
            {PORTFOLIO_RECORDED.label} · {PORTFOLIO_RECORDED.asOf}
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
            <h3>Contract authority & risk</h3>
            <span className="badge badge-pass">LEDGER-ONLY FA</span>
          </div>
          <dl className="kv">
            <dt>Owner</dt>
            <dd className="mono">{CONFIG.ownerAccount}</dd>
            <dt>Policy</dt>
            <dd className="mono">{CONFIG.policyContract}</dd>
            <dt>Reconciler</dt>
            <dd className="mono">{GATE_G_ACCOUNTING.reconciler}</dd>
            <dt>Max trade</dt>
            <dd>{FROZEN_POLICY.max_trade_value}</dd>
            <dt>Slippage</dt>
            <dd>{FROZEN_POLICY.max_slippage_bps} bps</dd>
            <dt>H1 revoke</dt>
            <dd>
              epoch {HARDWARE_OWNERSHIP.revokeVerified.mandate_epoch} · revoked=
              {String(HARDWARE_OWNERSHIP.revokeVerified.revoked)}
            </dd>
          </dl>
          <p className="muted small">{HARDWARE_OWNERSHIP.note}</p>
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
              {liveKeys && <p className="small muted">{liveKeys}</p>}
              {err && <p className="err">{err}</p>}
              {quote && (
                <p className="small muted">
                  CURRENT LIVE READ · out {quote.quote?.amountOut ?? "—"}
                </p>
              )}
              {mandate && (
                <p className="small muted">
                  CURRENT LIVE READ · revoked={String(mandate.revoked?.revoked)} ·
                  epoch {String(mandate.epoch)}
                </p>
              )}
            </>
          )}
        </article>
      </div>

      <div className="cards-2">
        <article className="card feature-card">
          <div className="card-head">
            <h3>Latest strategy settle (H3)</h3>
            <span className="badge badge-pass">PASS · SETTLED</span>
          </div>
          <p>
            Deterministic TRADE · {H3_EXECUTION.operationId} · Tidepool{" "}
            {H3_EXECUTION.tidepoolStatus}
          </p>
          <div className="proof-links">
            <a
              href={`${CONFIG.etherscan}/tx/${H3_EXECUTION.sepoliaTx}`}
              target="_blank"
              rel="noreferrer"
            >
              Sepolia H3
            </a>
            <a
              href={`${CONFIG.nearblocks}/txns/${H3_EXECUTION.mpcSignTx}`}
              target="_blank"
              rel="noreferrer"
            >
              NEAR MPC
            </a>
            <a
              href={`${CONFIG.nearblocks}/txns/${H3_EXECUTION.reconcileTx}`}
              target="_blank"
              rel="noreferrer"
            >
              Reconcile
            </a>
          </div>
          <p className="muted small">Not LLM intelligence — strategy decide.mjs.</p>
        </article>

        <article className="card">
          <div className="card-head">
            <h3>Prior unattended (F4)</h3>
            <span className="badge badge-pass">PASS</span>
          </div>
          <p>
            {F4_EXECUTION.amountInDisplay} · {F4_EXECUTION.tidepoolStatus}
          </p>
          <div className="proof-links">
            <a
              href={`${CONFIG.etherscan}/tx/${F4_EXECUTION.sepoliaTx}`}
              target="_blank"
              rel="noreferrer"
            >
              Sepolia F4
            </a>
            <a
              href={`${CONFIG.nearblocks}/txns/${F4_EXECUTION.nearSettlementTxs[0]}`}
              target="_blank"
              rel="noreferrer"
            >
              NEAR F4
            </a>
          </div>
        </article>
      </div>
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
