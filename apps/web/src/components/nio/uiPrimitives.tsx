import { useState, type ReactNode } from "react";
import { Copy, ExternalLink, Check } from "lucide-react";

export function StatusBadge({
  children,
  tone = "idle",
}: {
  children: string;
  tone?: "success" | "warn" | "danger" | "idle" | "running" | "recorded";
}) {
  return <span className={`nio-badge nio-badge-${tone}`}>{children}</span>;
}

export function MetricCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div className="axis-stat nio-metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}

export function IdentityRow({
  label,
  value,
  mono = true,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="nio-identity-row">
      <span className="nio-identity-label">{label}</span>
      <span className={mono ? "mono nio-wrap-addr" : "nio-wrap-addr"}>{value}</span>
    </div>
  );
}

export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="nio-empty-state">
      <p>{title}</p>
      {detail ? <p className="axis-supporting">{detail}</p> : null}
      {action}
    </div>
  );
}

function shortHash(value: string, head = 10): string {
  if (!value) return "—";
  if (value.length <= head + 1) return value;
  return `${value.slice(0, head)}…`;
}

export function HashWithActions({
  label,
  value,
  href,
  title,
}: {
  label: string;
  value: string;
  href?: string;
  title?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="nio-hash-row" title={title || value}>
      <span className="nio-hash-label">{label}</span>
      <code className="mono nio-hash-value">{shortHash(value)}</code>
      <div className="nio-hash-actions">
        <button
          type="button"
          className="axis-icon-button"
          aria-label={copied ? "Copied" : "Copy hash"}
          title={copied ? "Copied" : "Copy"}
          onClick={() => void copy()}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
        {href ? (
          <a
            className="axis-icon-button"
            href={href}
            target="_blank"
            rel="noreferrer"
            aria-label="Open explorer"
            title="Explorer"
          >
            <ExternalLink size={14} />
          </a>
        ) : null}
      </div>
    </div>
  );
}

export function EvidenceTimeline({
  items,
  collapsedCount = 3,
}: {
  items: { id: string; title: string; hash: string; href?: string }[];
  collapsedCount?: number;
}) {
  const [open, setOpen] = useState(false);
  const head = items.slice(0, collapsedCount);
  const rest = items.slice(collapsedCount);
  return (
    <div className="nio-evidence-timeline">
      {head.map((item) => (
        <HashWithActions
          key={item.id}
          label={item.title}
          value={item.hash}
          href={item.href}
        />
      ))}
      {rest.length > 0 ? (
        <>
          {open
            ? rest.map((item) => (
                <HashWithActions
                  key={item.id}
                  label={item.title}
                  value={item.hash}
                  href={item.href}
                />
              ))
            : null}
          <button
            type="button"
            className="axis-button secondary"
            style={{ marginTop: 8 }}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide older proofs" : `View all proofs (${rest.length} more)`}
          </button>
        </>
      ) : null}
    </div>
  );
}

export function explainReasonCode(code: string | null | undefined): string {
  const c = String(code || "").toUpperCase();
  if (!c) return "No reason recorded.";
  if (c.includes("NO_OPPORTUNITY")) {
    return "No trade opportunity met mandate limits and safety criteria in this cycle.";
  }
  if (c.includes("ECONOMIC")) {
    return "The proposed trade failed economic viability checks.";
  }
  if (c.includes("REJECT")) {
    return "The critic or fitter rejected the proposal.";
  }
  if (c.includes("PAUSE") || c.includes("REVOK")) {
    return "Trading was blocked by pause or revoke state.";
  }
  if (c.includes("SLIPPAGE")) {
    return "Quoted slippage exceeded the mandate allowance.";
  }
  return `Decision reason: ${code}.`;
}

export function governanceTitle(kind: string): string {
  const map: Record<string, string> = {
    DeployContract: "Deploy policy contract",
    migrate_state_v1_autonomy: "Autonomy state migration",
    activate_autonomous_mandate: "Activate autonomous mandate",
    unpause: "Unpause trading",
    DeployContract_audit_wasm: "Audit WASM upgrade",
    migrate_state_v2_decision_audit: "Decision-audit migration",
    record_decision_cycle_NO_TRADE: "NO_TRADE audit receipt",
  };
  return map[kind] || kind.replace(/_/g, " ");
}
