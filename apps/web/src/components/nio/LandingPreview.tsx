import { RefreshCw } from "lucide-react";
import { loadHostedEvidenceRecord } from "../../adapters/gatej";

export function LandingPreview({ onOpenAgent }: { onOpenAgent: () => void }) {
  const rec = loadHostedEvidenceRecord();
  const models = rec?.models;
  const final =
    rec?.enforcement?.decision ?? rec?.summary?.final_decision ?? "BLOCKED";
  const fitter = rec?.summary?.fitter_outcome ?? rec?.fit?.verdict ?? "REJECTED";
  const critic = rec?.summary?.critic_verdict ?? rec?.critic?.verdict ?? "ABSTAIN";

  return (
    <>
      <div className="landing-canvas-label">
        <span>NIO DECISION PREVIEW</span>
        <span>RECORDED · DRY RUN</span>
      </div>
      <div className="landing-live-preview">
        <div className="landing-preview-top">
          <span>
            <i aria-hidden="true" />
            Live AI pipeline
          </span>
          <span className="landing-preview-source">OPENROUTER · NO SIGN</span>
        </div>
        <div className="landing-preview-heading">
          <h3>Multi-agent dry-run</h3>
          <button type="button" aria-label="Open AI Agent" onClick={onOpenAgent}>
            <RefreshCw size={18} />
          </button>
        </div>
        <div className="landing-preview-tabs" role="tablist">
          <button type="button" aria-pressed="true">
            Pipeline
          </button>
          <button type="button" aria-pressed="false" onClick={onOpenAgent}>
            Live run
          </button>
        </div>
        <p className="landing-preview-value">{final}</p>
        <p className="landing-preview-unit">
          Fitter {fitter} · Critic {critic} · may_sign=false
        </p>
        <dl className="nio-preview-pipeline">
          <div>
            <dt>Researcher</dt>
            <dd className="mono">{models?.researcher ?? "google/gemini-2.5-flash"}</dd>
          </div>
          <div>
            <dt>Strategist</dt>
            <dd className="mono">{models?.strategist ?? "anthropic/claude-sonnet-4.6"}</dd>
          </div>
          <div>
            <dt>Fitter</dt>
            <dd>{fitter}</dd>
          </div>
          <div>
            <dt>Critic</dt>
            <dd className="mono">
              {critic} · {models?.critic ?? "openai/gpt-5.2"}
            </dd>
          </div>
        </dl>
        <div className="landing-preview-bottom">
          <span>
            Portfolio <b>i-a-a4e7</b>
          </span>
          <span>
            Mode <b>RECORDED</b>
          </span>
        </div>
        <p className="landing-preview-caption">
          Recorded hosted OpenRouter evidence — not a fabricated live call. Run
          Live AI Analysis in the workspace for a fresh dry-run.
        </p>
        <button type="button" className="landing-preview-link" onClick={onOpenAgent}>
          Open AI Agent
          <span aria-hidden="true">↗</span>
        </button>
      </div>
    </>
  );
}
