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
import { DecisionJourney } from "../DecisionJourney";
import { MandateFitterPanel } from "../MandateFitter";
import { GateKEvidence } from "../GateKEvidence";

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

export function AgentWorkspace() {
  const publicLiveAi = isPublicLiveAiEnabled();
  const [gateJ, setGateJ] = useState({ available: false, detail: "Checking Gate J…" });
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
      detail: record?.stages?.find((s) => s.id === "market_research")?.detail,
    },
    {
      name: "Strategist",
      model: record?.models?.strategist ?? "anthropic/claude-sonnet-4.6",
      status: record ? "done" : "idle",
      detail: record?.proposal?.choice ?? "—",
    },
    {
      name: "Mandate Fitter",
      model: "deterministic_v1",
      status: record ? "done" : "idle",
      detail: record?.fit?.verdict ?? "—",
    },
    {
      name: "Risk Critic",
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
      name: "Final Decision",
      model: "enforcement",
      status: record ? "done" : "idle",
      detail: `${record?.enforcement?.decision ?? "—"} · may_sign=${record?.enforcement?.may_sign ?? false}`,
    },
  ];

  return (
    <div className="page-enter" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div className="axis-intro">
        <div>
          <h1>AI Agent</h1>
          <p>
            Analytical console for Researcher → Strategist → Fitter → Critic →
            Policy Guard. Live runs use demo-decide only.
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
            <span className="axis-badge">LIVE AI · DRY RUN · NO SIGNING</span>
          </div>
          <p>
            Gate J: {gateJ.detail}
            {demoStatus?.ok
              ? ` · demo available · global remaining ${demoStatus.remaining?.global_calls ?? "—"}`
              : demoStatus?.reason
                ? ` · ${demoStatus.reason}`
                : ""}
          </p>
          {msg ? <p role="alert">{msg}</p> : null}
        </div>
        <button
          type="button"
          className="axis-button"
          disabled={
            liveBusy ||
            !publicLiveAi ||
            !gateJ.available ||
            Boolean(demoStatus?.kill_switch) ||
            demoStatus?.ok === false
          }
          onClick={() => void runLive()}
        >
          {liveBusy ? "Running Live AI Analysis… (up to ~90s)" : "Run Live AI Analysis"}
        </button>
      </section>

      <div className="nio-pipeline" aria-label="Decision pipeline">
        {stages.map((s) => (
          <div key={s.name} className="nio-pipeline-stage">
            <span className="axis-badge">{s.status}</span>
            <strong>{s.name}</strong>
            <span className="mono">{s.model}</span>
            <span className="axis-supporting">{s.detail}</span>
          </div>
        ))}
      </div>

      <DecisionJourney record={record} />
      <MandateFitterPanel record={record} />

      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>Fixture scenarios</h2>
          <span className="axis-badge">DETERMINISTIC · NOT LLM</span>
        </div>
        <div className="axis-overview-actions">
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              type="button"
              className="axis-overview-action"
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
              <span>
                <b>{s.title}</b>
                <small>{s.blurb}</small>
              </span>
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
            <h2>Decision history</h2>
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

      <GateKEvidence />
    </div>
  );
}
