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
import { NIO_CHAINS, VERIFIED_TOKEN_OPTIONS } from "../../lib/chains";
import type { MainnetDecisionSummary } from "../../adapters/mainnetPublic";
import { MAINNET_EVIDENCE } from "../../data/mainnetEvidence";
import {
  formatLastUpdated,
  useWorkspace,
} from "../../state/WorkspaceContext";
import { LiveDataChrome } from "./WorkspaceSwitcher";
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
  const { isPublic, live, identities, personalProvisioned } = useWorkspace();
  const publicLiveAi = isPublicLiveAiEnabled();
  const [gateJ, setGateJ] = useState({ available: false, detail: "Checking Live AI…" });
  const [demoStatus, setDemoStatus] = useState<GateJDemoStatus | null>(null);
  const [record, setRecord] = useState<GateJDecisionRecord | null>(null);
  const [history, setHistory] = useState<GateJHistoryEntry[]>([]);
  const [liveBusy, setLiveBusy] = useState(false);
  const [scenarioBusy, setScenarioBusy] = useState<GateJScenarioId | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [selectedCycle, setSelectedCycle] = useState<string | null>(null);
  const mainnetDecisions: MainnetDecisionSummary[] = isPublic
    ? live.decisions
    : [];

  useEffect(() => {
    void gateJHealth().then(setGateJ);
    void fetchGateJHistory(12).then(setHistory);
    if (publicLiveAi) void fetchDemoStatus().then(setDemoStatus);
  }, [publicLiveAi]);

  useEffect(() => {
    if (mainnetDecisions[0]?.cycle_id && !selectedCycle) {
      setSelectedCycle(mainnetDecisions[0].cycle_id);
    }
  }, [mainnetDecisions, selectedCycle]);

  const refresh = async () => {
    setGateJ(await gateJHealth());
    setHistory(await fetchGateJHistory(12));
    if (publicLiveAi) setDemoStatus(await fetchDemoStatus());
    if (isPublic) await live.refresh();
  };

  const selectedDecision =
    mainnetDecisions.find((d) => d.cycle_id === selectedCycle) ??
    mainnetDecisions[0] ??
    null;

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

  const mainnetStages = selectedDecision
    ? [
        {
          name: "Researcher",
          model: "LIVE_LLM",
          status: "done",
          detail: "Market research completed for cycle",
        },
        {
          name: "Strategist",
          model: "LIVE_LLM",
          status: "done",
          detail: selectedDecision.reason_code || "proposal recorded",
        },
        {
          name: "Fitter",
          model: "deterministic",
          status: "done",
          detail: selectedDecision.fitter_verdict,
        },
        {
          name: "Critic",
          model: "LIVE_LLM",
          status: "done",
          detail: selectedDecision.critic_verdict,
        },
        {
          name: "Policy Guard",
          model: "NEAR policy",
          status: "done",
          detail: `epoch ${selectedDecision.mandate_epoch}`,
        },
        {
          name: "Final",
          model: "enforcement",
          status: "done",
          detail: `${selectedDecision.final_action} · ${selectedDecision.status}`,
        },
      ]
    : stages;

  return (
    <div className="page-enter nio-agent-page">
      <div className="axis-intro">
        <div>
          <h1>AI Agent</h1>
          <p>
            {isPublic
              ? `Live autonomous decisions for ${identities.agent} on NEAR mainnet (read-only).`
              : personalProvisioned
                ? "Personal agent workspace — mutations only when authorized."
                : "Personal agent not provisioned. Switch to Nishanth's agent for the live mainnet showcase."}
          </p>
        </div>
        <div className="axis-actions">
          <button type="button" className="axis-button secondary" onClick={() => void refresh()}>
            Refresh status
          </button>
          <button type="button" className="axis-button secondary" onClick={() => onNav("verify")}>
            Proof &amp; Verify
          </button>
        </div>
      </div>

      {isPublic ? <LiveDataChrome /> : null}

      {isPublic ? (
      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>Live autonomous agent (mainnet)</h2>
          <span className="nio-badge nio-badge-success">MAINNET</span>
        </div>
        <p className="axis-supporting">
          Mandate epoch{" "}
          {live.mandate?.mandate_epoch ?? MAINNET_EVIDENCE.policy.epoch} ·
          autonomous=
          {String(
            live.mandate?.autonomous_trading ??
              MAINNET_EVIDENCE.autonomy.autonomous_trading
          )}{" "}
          · enforce=
          {String(
            live.mandate?.enforce_autonomous_on_agent ??
              MAINNET_EVIDENCE.autonomy.enforce_autonomous_on_agent
          )}{" "}
          · Updated {formatLastUpdated(live.lastUpdated)}
        </p>
        <div className="nio-pipeline" aria-label="Mainnet decision pipeline">
          {mainnetStages.map((s, i) => {
            const tone = stageTone(s.status, s.detail);
            return (
              <div key={s.name} className={`nio-pipeline-stage tone-${tone}`}>
                <div className="nio-pipeline-top">
                  <span className="nio-pipeline-num">{String(i + 1).padStart(2, "0")}</span>
                  <span
                    className={`nio-badge nio-badge-${
                      tone === "idle"
                        ? "idle"
                        : tone === "success"
                          ? "success"
                          : tone === "warn"
                            ? "warn"
                            : tone === "danger"
                              ? "danger"
                              : "running"
                    }`}
                  >
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
        <ol className="nio-decision-timeline">
          {mainnetDecisions.length === 0 && (
            <li className="axis-supporting">
              {live.status === "error"
                ? `Live decisions unavailable: ${live.error}`
                : "No OCI-indexed audit cycles yet."}
            </li>
          )}
          {mainnetDecisions.map((d) => (
            <li key={d.cycle_id}>
              <button
                type="button"
                className="axis-inline-link"
                style={{
                  fontWeight: selectedDecision?.cycle_id === d.cycle_id ? 700 : 400,
                }}
                onClick={() => setSelectedCycle(d.cycle_id)}
              >
                <span className="mono">{new Date(d.timestamp_ms).toISOString()}</span>
              </button>{" "}
              · <span className="nio-badge nio-badge-warn">FITTER {d.fitter_verdict}</span>{" "}
              <span className="nio-badge nio-badge-idle">CRITIC {d.critic_verdict}</span>{" "}
              <span className="nio-badge nio-badge-danger">{d.final_action}</span> · epoch{" "}
              {d.mandate_epoch} · {d.reason_code} · status {d.status}
              {d.evidence_hash ? (
                <>
                  {" "}
                  · evidence <span className="mono">{d.evidence_hash.slice(0, 12)}…</span>
                </>
              ) : null}
              {d.explorer ? (
                <>
                  {" "}
                  ·{" "}
                  <a href={d.explorer} target="_blank" rel="noreferrer">
                    audit tx
                  </a>
                </>
              ) : null}
            </li>
          ))}
        </ol>
        {selectedDecision?.explorer?.includes("CXR4ey") ||
        selectedDecision?.near_tx ===
          "CXR4ey3x2x3scEhGeW8sRLnRAVsPrsYiRYFPcTAAAz1s" ? (
          <p className="axis-supporting">
            Anchored NO_TRADE proof includes Fitter REJECTED trail on{" "}
            <a
              href="https://nearblocks.io/txns/CXR4ey3x2x3scEhGeW8sRLnRAVsPrsYiRYFPcTAAAz1s"
              target="_blank"
              rel="noreferrer"
            >
              CXR4ey…
            </a>
          </p>
        ) : null}
      </section>
      ) : (
        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>Personal agent</h2>
            <span className="nio-badge nio-badge-warn">SETUP</span>
          </div>
          <p>
            {personalProvisioned
              ? "Your portfolio is bound. Autonomous mainnet execution for personal agents is only available when your own policy is provisioned and authorized."
              : "No personal agent provisioned. Use Owner auth → My Portfolio. This page will not show Nishanth's financial data."}
          </p>
          <div className="axis-actions">
            <button type="button" className="axis-button" onClick={() => onNav("owner")}>
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
      )}

      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>Route selection (network-aware)</h2>
          <span className="nio-badge nio-badge-warn">NO LIVE QUOTE</span>
        </div>
        <p className="axis-supporting">
          Source/destination chains and assets use verified identities. Estimated
          output, gas, and fees appear only from a real adapter quote — never
          invented. Public demo may_sign stays false.
        </p>
        <div
          className="axis-stats"
          style={{ gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))" }}
        >
          <div className="axis-stat">
            <span>Source chain</span>
            <strong style={{ fontSize: 15 }}>
              {NIO_CHAINS[1]?.short ?? "Arbitrum"}
            </strong>
            <small className="mono">{NIO_CHAINS[1]?.id}</small>
          </div>
          <div className="axis-stat">
            <span>Destination chain</span>
            <strong style={{ fontSize: 15 }}>NEAR</strong>
            <small className="mono">near</small>
          </div>
          <div className="axis-stat">
            <span>Asset in</span>
            <strong style={{ fontSize: 13 }} className="mono">
              {VERIFIED_TOKEN_OPTIONS.find((t) => t.chain === "eip155:42161")?.asset_id.slice(0, 28)}…
            </strong>
          </div>
          <div className="axis-stat">
            <span>Est. out / gas / fees</span>
            <strong style={{ fontSize: 15 }}>—</strong>
            <small>awaiting dry quote</small>
          </div>
          <div className="axis-stat">
            <span>Fitter / Critic</span>
            <strong style={{ fontSize: 15 }}>
              {record?.fit?.verdict ?? "—"} / {record?.critic?.verdict ?? "—"}
            </strong>
          </div>
        </div>
      </section>

      <section className="axis-panel">
        <div className="axis-panel-heading">
          <h2>{isPublic ? "Historical / lab dry-run (not mainnet keeper)" : "Live AI dry-run"}</h2>
          <span className="nio-badge nio-badge-recorded">
            {isPublic ? "LAB · NOT KEEPER" : "DRY RUN"}
          </span>
        </div>
        <p className="axis-supporting">
          {isPublic
            ? "Public dry-run and fixtures are separate from the autonomous mainnet keeper above. They never sign and never mutate Nishanth's policy."
            : "Dry-run console for personal exploration. Signing stays off."}
        </p>
      </section>

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
          <h2>Historical testnet execution</h2>
          <span className="nio-badge nio-badge-warn">TESTNET · OPERATOR OVERRIDE</span>
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
