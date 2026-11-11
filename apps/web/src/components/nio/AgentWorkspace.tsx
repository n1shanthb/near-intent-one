import { useEffect, useState } from "react";
import {
  fetchDemoStatus,
  fetchGateJHistory,
  gateJHealth,
  loadHostedEvidenceRecord,
  runFixtureScenario,
  runLiveAiDecide,
  type GateJDemoStatus,
} from "../../adapters/gatej";
import type { GateJDecisionRecord, GateJHistoryEntry, GateJScenarioId } from "../../types/gateJ";
import { isPublicLiveAiEnabled } from "../../lib/publicDemo";
import { GATE_K_FIRST_TRADE } from "../../data/gateKEvidence";
import { DecisionJourney } from "../DecisionJourney";
import { MandateFitterPanel } from "../MandateFitter";
import type { NavId } from "./nav";

const SCENARIOS: {
  id: GateJScenarioId;
  letter: string;
  title: string;
  blurb: string;
}[] = [
  {
    id: "A_ALLOWED",
    letter: "A",
    title: "ALLOWED",
    blurb: "Proposal already satisfies the mandate.",
  },
  {
    id: "B_ADAPTED",
    letter: "B",
    title: "ADAPTED",
    blurb: "Proposed $100; fitted down to $20 within the mandate.",
  },
  {
    id: "C_REJECTED",
    letter: "C",
    title: "REJECTED",
    blurb: "Strategy needs at least $50; mandate allows $20 — refuse.",
  },
];

function stageTone(
  status: string,
  detail?: string | null
): "idle" | "success" | "warn" | "danger" | "running" {
  if (status === "idle") return "idle";
  const d = (detail ?? "").toUpperCase();
  if (/REJECT|BLOCKED|NO_TRADE|VETO/.test(d)) return "danger";
  if (/ADAPT|ABSTAIN|WARN/.test(d)) return "warn";
  if (/ALLOW|APPROVE|DONE|ENFORCE/.test(d) || status === "done") return "success";
  return "running";
}

export function AgentWorkspace({ onNav }: { onNav: (id: NavId) => void }) {
  const publicLiveAi = isPublicLiveAiEnabled();
  const [gateJ, setGateJ] = useState({ available: false, detail: "Checking Live AI…" });
  const [demoStatus, setDemoStatus] = useState<GateJDemoStatus | null>(null);
  const [record, setRecord] = useState<GateJDecisionRecord | null>(null);
  const [history, setHistory] = useState<GateJHistoryEntry[]>([]);
  const [liveBusy, setLiveBusy] = useState(false);
  const [scenarioBusy, setScenarioBusy] = useState<GateJScenarioId | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void gateJHealth().then(setGateJ);
    void fetchGateJHistory(12).then(setHistory);
    if (publicLiveAi) void fetchDemoStatus().then(setDemoStatus);
  }, [publicLiveAi]);

  const refresh = async () => {
    setGateJ(await gateJHealth());
    setHistory(await fetchGateJHistory(12));
    if (publicLiveAi) setDemoStatus(await fetchDemoStatus());
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

  const stages = [
    {
      name: "Researcher",
      model: record?.models?.researcher ?? "google/gemini-2.5-flash",
      status: record ? "done" : "idle",
      detail: record?.stages?.find((s) => s.id === "market_research")?.detail ?? "—",
    },
    {
      name: "Strategist",
      model: record?.models?.strategist ?? "anthropic/claude-sonnet-4.6",
      status: record ? "done" : "idle",
      detail: record?.proposal?.choice ?? "—",
    },
    {
      name: "Fitter",
      model: "deterministic_v1",
      status: record ? "done" : "idle",
      detail: record?.fit?.verdict ?? "—",
    },
    {
      name: "Critic",
      model: record?.models?.critic ?? "openai/gpt-5.2",
      status: record ? "done" : "idle",
      detail: record?.critic?.verdict ?? "—",
    },
    {
      name: "Policy Guard",
      model: "NEAR policy",
      status: record ? "done" : "idle",
      detail: "AI cannot override NEAR",
    },
    {
      name: "Final",
      model: "enforcement",
      status: record ? "done" : "idle",
      detail: `${record?.enforcement?.decision ?? "—"} · may_sign=${record?.enforcement?.may_sign ?? false}`,
    },
  ];

  const clientLeft = demoStatus?.remaining?.client_calls;
  const globalLeft = demoStatus?.remaining?.global_calls;
  const quotaExhausted =
    (typeof globalLeft === "number" && globalLeft <= 0) ||
    (typeof clientLeft === "number" && clientLeft <= 0);
  const demoAvailable =
    Boolean(demoStatus?.ok) &&
    !demoStatus?.kill_switch &&
    demoStatus?.enabled !== false &&
    !quotaExhausted;
  const liveButtonEnabled =
    publicLiveAi &&
    gateJ.available &&
    demoAvailable &&
    !liveBusy;

  return (
    <div className="page-enter nio-agent-page">
      <div className="axis-intro">
        <div>
          <h1>AI Agent</h1>
          <p>
            Live multi-agent decisions governed by hardware-authorized NEAR policy.
          </p>
        </div>
        <div className="axis-actions">
          <button type="button" className="axis-button secondary" onClick={() => void refresh()}>
            Refresh status
          </button>
        </div>
      </div>

      <section className="nio-live-banner">
        <div>
          <div className="axis-actions" style={{ marginBottom: 10 }}>
            <span className="axis-badge">LIVE AI · DRY RUN</span>
            <span className="axis-badge">
              {demoAvailable
                ? "Demo available"
                : quotaExhausted
                  ? "Quota exhausted"
                  : publicLiveAi
                    ? "Demo paused / unreachable"
                    : "Live AI off"}
            </span>
            {typeof globalLeft === "number" ? (
              <span className="axis-badge">Global remaining {globalLeft}</span>
            ) : null}
            {typeof clientLeft === "number" ? (
              <span className="axis-badge">Your remaining {clientLeft}</span>
            ) : null}
          </div>
          <p>
            {gateJ.detail}
            {demoStatus?.ok === false &&
            demoStatus.reason &&
            !/upstream_|fetch failed|aborted|client_timeout/i.test(demoStatus.reason)
              ? ` · ${demoStatus.reason}`
              : ""}
          </p>
          <p>
            Live AI stays dry-run only (<span className="mono">may_sign=false</span>).
            Fixture scenarios below never spend OpenRouter budget.
          </p>
          {quotaExhausted ? (
            <p role="status">
              Quota exhausted — use fixture scenarios or recorded Gate K evidence instead of
              repeating Live AI calls.
            </p>
          ) : null}
          {msg ? <p role="alert">{msg}</p> : null}
        </div>
        <button
          type="button"
          className="axis-button"
          disabled={!liveButtonEnabled}
          onClick={() => void runLive()}
          title={
            liveButtonEnabled
              ? "Run one public dry-run"
              : "Live AI disabled until health + demo-status report available quota"
          }
        >
          {liveBusy ? "Running Live AI Analysis… (up to ~90s)" : "Run Live AI Analysis"}
        </button>
      </section>

      <div className="nio-pipeline" aria-label="Decision pipeline">
        {stages.map((s, i) => {
          const tone = stageTone(s.status, s.detail);
          return (
            <div key={s.name} className={`nio-pipeline-stage tone-${tone}`}>
              <div className="nio-pipeline-top">
                <span className="nio-pipeline-num">{String(i + 1).padStart(2, "0")}</span>
                <span className={`nio-badge nio-badge-${tone === "idle" ? "idle" : tone === "success" ? "success" : tone === "warn" ? "warn" : tone === "danger" ? "danger" : "running"}`}>
                  {s.status}
                </span>
              </div>
              <strong>{s.name}</strong>
              <span className="mono">{s.model}</span>
              <span className="axis-supporting">{s.detail}</span>
            </div>
          );
        })}
      </div>

      <DecisionJourney record={record} />
      <MandateFitterPanel record={record} />

      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>Fixture scenarios</h2>
          <span className="nio-badge nio-badge-recorded">DETERMINISTIC · NOT LLM</span>
        </div>
        <div className="nio-scenario-grid">
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`nio-scenario-card${scenarioBusy === s.id ? " selected" : ""}`}
              disabled={scenarioBusy !== null || liveBusy}
              onClick={() => {
                setScenarioBusy(s.id);
                setMsg(null);
                void runFixtureScenario(s.id)
                  .then(setRecord)
                  .catch((e) => setMsg(e instanceof Error ? e.message : String(e)))
                  .finally(() => setScenarioBusy(null));
              }}
            >
              <div className="nio-scenario-head">
                <span className="nio-scenario-letter">Scenario {s.letter}</span>
                <span
                  className={`nio-badge ${
                    s.title === "ALLOWED"
                      ? "nio-badge-success"
                      : s.title === "ADAPTED"
                        ? "nio-badge-warn"
                        : "nio-badge-danger"
                  }`}
                >
                  {s.title}
                </span>
              </div>
              <p>{s.blurb}</p>
            </button>
          ))}
        </div>
        <div className="axis-actions" style={{ marginTop: 14 }}>
          <button
            type="button"
            className="axis-button secondary"
            onClick={() => setRecord(loadHostedEvidenceRecord())}
          >
            Show recorded hosted OCI trace
          </button>
        </div>
      </section>

      {history.length ? (
        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>Recent decisions</h2>
          </div>
          <div className="axis-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Fitter</th>
                  <th>Final</th>
                </tr>
              </thead>
              <tbody>
                {history.slice(0, 8).map((h, i) => (
                  <tr key={`${h.at ?? i}-${i}`}>
                    <td className="mono">{h.at ?? "—"}</td>
                    <td>{h.fitter_outcome ?? "—"}</td>
                    <td>
                      {typeof h.summary?.final_decision === "string"
                        ? h.summary.final_decision
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="axis-panel nio-gatek-summary">
        <div className="axis-panel-heading">
          <h2>Real AI-directed execution</h2>
          <span className="nio-badge nio-badge-warn">OPERATOR OVERRIDE</span>
        </div>
        <p>
          24.45 USDC · Sepolia · Tidepool {GATE_K_FIRST_TRADE.execution.tidepool_status} ·
          Reconcile {GATE_K_FIRST_TRADE.execution.reconcile_status}
        </p>
        <p className="axis-supporting">
          Fitter rejected economics, Critic vetoed, and the transaction proceeded only after an
          explicitly authorized one-time operator acceptance override — not normal autonomous
          safety-approved execution.
        </p>
        <button
          type="button"
          className="axis-button secondary"
          onClick={() => onNav("evidence")}
        >
          View complete execution proof
        </button>
      </section>
    </div>
  );
}
