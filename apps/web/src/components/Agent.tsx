import { useEffect, useState } from "react";
import { CONFIG } from "../lib/config";
import {
  F4_EXECUTION,
  FROZEN_POLICY,
  GATE_G_ACCOUNTING,
  H3_DECISION,
  H3_EXECUTION,
} from "../data/evidenceSnapshot";
import { gateHStrategy, type StrategyDecisionLog } from "../adapters/gateh";
import {
  getAgentState,
  startAgent,
  stopAgent,
} from "../adapters/gatei";
import {
  authModeLabel,
  authorizationActionsEnabled,
  fetchGateJHistory,
  gateJHealth,
  isOnchainMandateHydrated,
  loadHostedEvidenceRecord,
  runFixtureScenario,
  fetchDemoStatus,
  runLiveAiDecide,
  type GateJDemoStatus,
} from "../adapters/gatej";
import type { AgentRuntimeState } from "../types/gateI";
import type {
  GateJDecisionRecord,
  GateJHistoryEntry,
  GateJScenarioId,
} from "../types/gateJ";
import { useProductSession } from "../state/ProductSession";
import { GateIBanner } from "./GateIBanner";
import { DecisionJourney } from "./DecisionJourney";
import { MandateFitterPanel } from "./MandateFitter";
import { GateKEvidence } from "./GateKEvidence";
import { usdcDisplay } from "../lib/mandateFitter";
import { isPublicLiveAiEnabled } from "../lib/publicDemo";

const SCENARIOS: { id: GateJScenarioId; title: string; blurb: string }[] = [
  {
    id: "A_ALLOWED",
    title: "A · ALLOWED",
    blurb: "Fixture proposal already satisfies the mandate.",
  },
  {
    id: "B_ADAPTED",
    title: "B · ADAPTED",
    blurb: "Fixture proposes $100; mandate $20; Fitter finds a viable $20 trade.",
  },
  {
    id: "C_REJECTED",
    title: "C · REJECTED",
    blurb: "Fixture proposes $100; mandate $20; strategy needs ≥$50 — refuse.",
  },
];

export function AgentPanel() {
  const { portfolio, gateI } = useProductSession();
  const [decision, setDecision] = useState<StrategyDecisionLog | null>(null);
  const [runtime, setRuntime] = useState<AgentRuntimeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [gateJ, setGateJ] = useState<{
    available: boolean;
    detail: string;
    llm?: Record<string, unknown>;
  }>({
    available: false,
    detail: "Checking Gate J…",
  });
  const [record, setRecord] = useState<GateJDecisionRecord | null>(null);
  const [scenarioBusy, setScenarioBusy] = useState<GateJScenarioId | null>(null);
  const [liveBusy, setLiveBusy] = useState(false);
  const [history, setHistory] = useState<GateJHistoryEntry[]>([]);
  const [demoStatus, setDemoStatus] = useState<GateJDemoStatus | null>(null);
  const onchainMandate = isOnchainMandateHydrated();
  const authOk = authorizationActionsEnabled();
  const publicLiveAi = isPublicLiveAiEnabled();

  useEffect(() => {
    void gateHStrategy.getLatestDecision().then(setDecision);
    void gateJHealth().then(setGateJ);
    void fetchGateJHistory(12).then(setHistory);
    if (publicLiveAi) {
      void fetchDemoStatus().then(setDemoStatus);
    }
  }, [publicLiveAi]);

  useEffect(() => {
    if (!portfolio || gateI.status !== "available") {
      setRuntime(null);
      return;
    }
    let cancelled = false;
    void getAgentState(portfolio.portfolio_id).then((s) => {
      if (!cancelled) setRuntime(s);
    });
    return () => {
      cancelled = true;
    };
  }, [portfolio, gateI.status]);

  const d = decision ?? {
    ...H3_DECISION,
    execution: {
      operationId: H3_EXECUTION.operationId,
      mpcSignTx: H3_EXECUTION.mpcSignTx,
      sepoliaTx: H3_EXECUTION.sepoliaTx,
      tidepoolStatus: H3_EXECUTION.tidepoolStatus,
      reconcileTx: H3_EXECUTION.reconcileTx,
    },
  };

  const refreshGateJ = async () => {
    const h = await gateJHealth();
    setGateJ(h);
    setHistory(await fetchGateJHistory(12));
    if (publicLiveAi) setDemoStatus(await fetchDemoStatus());
  };

  const runStart = async () => {
    if (!portfolio) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await startAgent(portfolio.portfolio_id);
      if (!res.ok) setMsg(res.reason ?? "Start blocked");
      else setRuntime(await getAgentState(portfolio.portfolio_id));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runStop = async () => {
    if (!portfolio) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await stopAgent(portfolio.portfolio_id);
      if (!res.ok) setMsg(res.reason ?? "Stop blocked");
      else setRuntime(await getAgentState(portfolio.portfolio_id));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runLive = async () => {
    if (liveBusy) return;
    setLiveBusy(true);
    setMsg(null);
    try {
      const rec = await runLiveAiDecide();
      setRecord(rec);
      setHistory(await fetchGateJHistory(12));
      setDemoStatus(await fetchDemoStatus());
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
      if (publicLiveAi) setDemoStatus(await fetchDemoStatus());
    } finally {
      setLiveBusy(false);
    }
  };

  const showHostedEvidence = () => {
    setMsg(null);
    setRecord(loadHostedEvidenceRecord());
  };

  const runScenario = async (id: GateJScenarioId) => {
    setScenarioBusy(id);
    setMsg(null);
    try {
      const rec = await runFixtureScenario(id, portfolio?.portfolio_id);
      setRecord(rec);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setScenarioBusy(null);
    }
  };

  const blockedOk =
    record?.enforcement?.decision === "BLOCKED" &&
    record?.safety_story?.blocked_is_success;

  return (
    <div className="stack">
      <section className="card hero-demo">
        <p className="eyebrow">Gate J · signature intelligence</p>
        <h2>
          NIO finds the best viable version of an AI strategy within the owner&apos;s
          rules — and NEAR enforces those rules.
        </h2>
        <p className="lede">
          AI Strategist → Deterministic Mandate Fitter → Independent Risk Critic →
          NEAR Policy → Enforcement. AI approval never overrides NEAR. OpenRouter
          stays server-side — never in the browser.
        </p>
      </section>

      {/* ── 1. LIVE AI / DRY RUN ─────────────────────────────────────── */}
      <section className="card">
        <div className="card-head">
          <h3>1 · LIVE AI / DRY RUN</h3>
          <span className="badge badge-pass">REAL OPENROUTER · NO SIGNING</span>
        </div>
        <p className="muted">
          Public judges call <span className="mono">POST /api/v1/gate-j/demo-decide</span>{" "}
          (fixed portfolio <span className="mono">i-a-a4e7</span>, forced dry-run,{" "}
          <span className="mono">may_sign=false</span>). Auth: {authModeLabel()}. No wallet
          required. Signing / Gate K override remain blocked.
        </p>
        <p className={`banner ${gateJ.available ? "banner-ok" : "banner-block"}`}>
          Gate J API: {gateJ.detail}
          <button type="button" className="ghost tiny" onClick={() => void refreshGateJ()}>
            Retry
          </button>
        </p>
        {publicLiveAi && demoStatus ? (
          <p
            className={`banner ${
              demoStatus.ok && !demoStatus.kill_switch ? "banner-ok" : "banner-block"
            }`}
          >
            Live AI demo:{" "}
            {demoStatus.kill_switch
              ? "kill switch ON"
              : demoStatus.ok
                ? `available · portfolio ${demoStatus.portfolio_id ?? "i-a-a4e7"} · global remaining ${
                    demoStatus.remaining?.global_calls ?? "—"
                  }`
                : demoStatus.reason ?? "unavailable"}
          </p>
        ) : null}
        <p className="muted small">
          On-chain mandate flag:{" "}
          {onchainMandate ? (
            <span className="badge badge-pass">VITE_GATE_J_ONCHAIN_MANDATE=true</span>
          ) : (
            <span className="badge badge-warn">false — demo uses server-hydrated mandate</span>
          )}
          {" · "}Results labeled <strong>LIVE AI — DRY RUN</strong> (not an on-chain trade).
        </p>
        {!publicLiveAi ? (
          <p className="banner banner-block">
            Public live OpenRouter dry-run is <strong>disabled</strong> on this build. Use
            recorded hosted trace + fixtures below.
          </p>
        ) : null}
        {msg ? (
          <p className="banner banner-block" role="alert">
            {msg}
          </p>
        ) : null}
        <div className="row gap">
          <button
            type="button"
            disabled={
              liveBusy ||
              !publicLiveAi ||
              !gateJ.available ||
              Boolean(demoStatus?.kill_switch) ||
              demoStatus?.ok === false
            }
            onClick={() => void runLive()}
          >
            {liveBusy
              ? "Running Live AI Analysis… (up to ~90s)"
              : "Run Live AI Analysis"}
          </button>
          <button
            type="button"
            className="ghost"
            disabled={liveBusy}
            onClick={showHostedEvidence}
          >
            Show recorded hosted OCI trace
          </button>
        </div>
        <p className="muted small">
          Hosted OCI evidence: Strategist <strong>NO_TRADE</strong> → Fitter REJECTED → Critic{" "}
          <strong>ABSTAIN</strong> → BLOCKED / may_sign=false (not TRADE/REJECT).
        </p>
        {!gateJ.available ? (
          <p className="warn small">
            Gate J health unreachable. Fixtures and recorded evidence still work offline.
          </p>
        ) : null}
      </section>

      {/* ── 2. FIXTURE SCENARIOS ─────────────────────────────────────── */}
      <section className="card">
        <div className="card-head">
          <h3>2 · FIXTURE SCENARIOS</h3>
          <span className="badge badge-warn">DETERMINISTIC FITTER · NOT LLM</span>
        </div>
        <p className="muted">
          ALLOWED / ADAPTED / REJECTED demonstrations using the real Mandate Fitter.
          Scenario proposals are canned inputs — never labeled as live LLM.
        </p>
        <div className="scenario-row">
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              type="button"
              className="onboard-card"
              disabled={scenarioBusy !== null || liveBusy}
              onClick={() => void runScenario(s.id)}
            >
              <strong>{s.title}</strong>
              <p>{s.blurb}</p>
              <span className="badge badge-recorded">
                {scenarioBusy === s.id ? "Running…" : "Run fixture"}
              </span>
            </button>
          ))}
        </div>
        {msg ? <p className="warn">{msg}</p> : null}
      </section>

      <DecisionJourney record={record} />
      <MandateFitterPanel record={record} />

      {record ? (
        <section className="card">
          <div className="card-head">
            <h3>Risk · enforcement · transparency</h3>
            <span className="badge badge-warn">AI ≠ POLICY OVERRIDE</span>
          </div>
          {blockedOk ? (
            <p className="banner banner-ok">
              Enforcement BLOCKED is a successful safety result (Critic{" "}
              {record.critic?.verdict ?? "—"} · Strategist{" "}
              {record.proposal?.choice ?? "—"}). Signing stayed off.
            </p>
          ) : null}
          <dl className="kv dense">
            <dt>Risk Critic</dt>
            <dd>
              <span
                className={`badge ${
                  record.critic?.verdict === "APPROVE"
                    ? "badge-pass"
                    : record.critic?.verdict === "ABSTAIN"
                      ? "badge-warn"
                      : "badge-danger"
                }`}
              >
                {record.critic?.verdict ?? "—"}
              </span>{" "}
              · {record.critic?.source} · {record.critic?.model}
              <div className="muted small">{record.critic?.rationale}</div>
            </dd>
            <dt>Enforcement</dt>
            <dd>
              <span
                className={`badge ${
                  record.enforcement?.decision === "BLOCKED"
                    ? "badge-pass"
                    : record.enforcement?.decision === "NO_TRADE"
                      ? "badge-warn"
                      : "badge-pass"
                }`}
              >
                {record.enforcement?.decision ?? "—"}
              </span>
              <span className="badge badge-recorded">
                {" "}
                may_sign={String(record.enforcement?.may_sign ?? false)}
              </span>
              <div className="muted small">
                {(record.enforcement?.reason_codes ?? []).join(", ") ||
                  record.enforcement?.note}
              </div>
            </dd>
            <dt>Mandate source</dt>
            <dd>
              <span className="mono">{record.mandate?.source ?? "—"}</span>
            </dd>
            <dt>Policy constraints</dt>
            <dd>
              <ul className="tight-list">
                {(record.policy?.constraints ?? []).map((c) => (
                  <li key={c.name}>
                    {c.ok ? "✓" : "✗"} {c.name}
                    {c.detail ? ` · ${c.detail}` : ""}
                  </li>
                ))}
              </ul>
              <span className="muted small">
                near_enforced={String(record.policy?.near_enforced)} ·{" "}
                {record.policy?.source}
              </span>
            </dd>
            <dt>Execution</dt>
            <dd>
              <span
                className={`badge ${
                  record.execution?.choice === "BLOCKED"
                    ? "badge-pass"
                    : record.execution?.choice === "TRADE"
                      ? "badge-pass"
                      : "badge-warn"
                }`}
              >
                {record.execution?.choice ?? "—"}
              </span>
              {record.execution?.dry_run ? (
                <span className="badge badge-recorded"> DRY-RUN</span>
              ) : null}
              <div className="muted small">{record.execution?.rationale}</div>
              <p className="muted small">
                No on-chain receipts in dry-run. Funded path disabled.
              </p>
            </dd>
            <dt>Market data</dt>
            <dd className="mono small">
              {record.proposal?.market_data?.venue ?? "—"} · as_of{" "}
              {record.proposal?.market_data?.as_of ?? "—"} · freshness_s{" "}
              {record.proposal?.market_data?.freshness_s ?? "—"}
            </dd>
            <dt>Fit summary</dt>
            <dd>
              {record.fit?.verdict}: {usdcDisplay(record.fit?.original_amount ?? null)} →{" "}
              {usdcDisplay(record.fit?.final_amount ?? null)}
            </dd>
          </dl>
        </section>
      ) : null}

      {history.length > 0 ? (
        <section className="card">
          <div className="card-head">
            <h3>Decision history</h3>
            <span className="badge badge-recorded">API</span>
          </div>
          <ul className="tight-list">
            {history.map((h, i) => (
              <li key={`${h.at}-${i}`}>
                <span className="mono small">{h.at}</span> ·{" "}
                {h.fitter_outcome ??
                  (h.summary as { fitter_outcome?: string } | undefined)
                    ?.fitter_outcome ??
                  "—"}{" "}
                ·{" "}
                {(h.summary as { final_decision?: string } | undefined)
                  ?.final_decision ??
                  h.operation_id ??
                  "—"}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="card">
        <div className="card-head">
          <h3>Your agent runtime</h3>
          <span className="badge badge-warn">LIVE GATE I</span>
        </div>
        <GateIBanner action="Start / stop agent" />
        {!authOk ? (
          <p className="banner banner-block">
            Funded / authorize-trade stays disabled until on-chain mandate hydration is confirmed
            on-chain mandate hydration (
            <span className="mono">VITE_GATE_J_ONCHAIN_MANDATE=true</span>). Fixture
            mandates are never shown as your live policy. Gate I start/stop preserved.
          </p>
        ) : null}
        {!portfolio ? (
          <p className="muted">
            Create a personal portfolio to control a hosted agent. Historical H3
            evidence below is separate.
          </p>
        ) : (
          <>
            <dl className="kv dense">
              <dt>Portfolio</dt>
              <dd className="mono">{portfolio.portfolio_id}</dd>
              <dt>Running</dt>
              <dd>
                {runtime
                  ? runtime.running
                    ? "yes"
                    : "no"
                  : gateI.status !== "available"
                    ? "unavailable"
                    : "loading…"}
              </dd>
              <dt>Strategy</dt>
              <dd className="mono">{runtime?.strategy_id ?? "—"}</dd>
              <dt>Source</dt>
              <dd>{runtime?.source ?? "unavailable"}</dd>
            </dl>
            {runtime?.last_decision ? (
              <dl className="kv dense">
                <dt>Last decision</dt>
                <dd>
                  <span
                    className={`badge ${
                      runtime.last_decision.choice === "TRADE"
                        ? "badge-pass"
                        : "badge-warn"
                    }`}
                  >
                    {runtime.last_decision.choice}
                  </span>
                </dd>
                <dt>Rationale</dt>
                <dd>{runtime.last_decision.rationale}</dd>
              </dl>
            ) : (
              <p className="muted small">No live decision from Gate I yet.</p>
            )}
            <div className="row gap">
              <button
                type="button"
                disabled={busy || gateI.status !== "available" || runtime?.running}
                onClick={() => void runStart()}
              >
                Start agent
              </button>
              <button
                type="button"
                className="ghost"
                disabled={busy || gateI.status !== "available" || !runtime?.running}
                onClick={() => void runStop()}
              >
                Stop trading
              </button>
            </div>
          </>
        )}
      </section>

      <GateKEvidence />

      {/* ── 3. RECORDED ON-CHAIN ─────────────────────────────────────── */}
      <section className="card">
        <div className="card-head">
          <h3>3 · RECORDED ON-CHAIN</h3>
          <span className="badge badge-recorded">HISTORICAL GATE I / H · NOT LLM</span>
        </div>
        <p className="warn">
          Historical trades below were <strong>not</strong> generated by the new LLM
          pipeline. They are recorded Gate H/I execution evidence.
        </p>
        <p>
          Demo agent <span className="mono">{CONFIG.agentAccount}</span> · policy{" "}
          <span className="mono">{CONFIG.policyContract}</span> · reconciler{" "}
          <span className="mono">{GATE_G_ACCOUNTING.reconciler}</span> ≠ agent (H2).
        </p>
      </section>

      <section className="card feature-card">
        <div className="card-head">
          <h3>H3 deterministic decision</h3>
          <span className="badge badge-pass">{d.choice}</span>
        </div>
        <p className="warn">
          Deterministic autonomous strategy — <strong>not</strong> LLM-generated
          trading intelligence. {H3_DECISION.ai_note}
        </p>
        <dl className="kv dense">
          <dt>Strategy</dt>
          <dd className="mono">{d.strategy_id}</dd>
          <dt>When</dt>
          <dd>{d.timestamp}</dd>
          <dt>Amount</dt>
          <dd>
            {d.amount_in} base ({H3_DECISION.amountInDisplay})
          </dd>
          <dt>Rationale</dt>
          <dd>{d.rationale}</dd>
        </dl>
        <h4>Risk checks observed</h4>
        <ul className="chip-row">
          {d.checks.map((c) => (
            <li key={c.name}>
              {c.ok ? "✓" : "✗"} {c.name}
              {c.headroom != null ? ` · headroom ${String(c.headroom)}` : ""}
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>H3 settlement proof</h3>
          <span className="badge badge-pass">SUCCESS</span>
        </div>
        <ol className="proof-ol">
          <li>
            Propose{" "}
            <a
              href={`${CONFIG.nearblocks}/txns/${H3_EXECUTION.proposeTx}`}
              target="_blank"
              rel="noreferrer"
            >
              {H3_EXECUTION.proposeTx.slice(0, 12)}…
            </a>
          </li>
          <li>
            MPC{" "}
            <a
              href={`${CONFIG.nearblocks}/txns/${H3_EXECUTION.mpcSignTx}`}
              target="_blank"
              rel="noreferrer"
            >
              {H3_EXECUTION.mpcSignTx.slice(0, 12)}…
            </a>
          </li>
          <li>
            Sepolia{" "}
            <a
              href={`${CONFIG.etherscan}/tx/${H3_EXECUTION.sepoliaTx}`}
              target="_blank"
              rel="noreferrer"
            >
              0xba28b97b…
            </a>{" "}
            status {H3_EXECUTION.sepoliaStatus}
          </li>
          <li>Tidepool {H3_EXECUTION.tidepoolStatus}</li>
          <li>
            Reconcile by {H3_EXECUTION.reconcileActor}{" "}
            <a
              href={`${CONFIG.nearblocks}/txns/${H3_EXECUTION.reconcileTx}`}
              target="_blank"
              rel="noreferrer"
            >
              {H3_EXECUTION.reconcileTx.slice(0, 12)}…
            </a>
          </li>
        </ol>
        <p className="muted small">
          Frozen limits: max trade {FROZEN_POLICY.max_trade_value}, slippage{" "}
          {FROZEN_POLICY.max_slippage_bps} bps. Earlier F4: {F4_EXECUTION.operationId}.
        </p>
      </section>
    </div>
  );
}
