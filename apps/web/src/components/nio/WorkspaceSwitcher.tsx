import { Eye, UserRound } from "lucide-react";
import {
  formatLastUpdated,
  useWorkspace,
} from "../../state/WorkspaceContext";
import type { WorkspaceMode } from "../../lib/workspaceIds";

/**
 * Two-workspace switcher — same visual chip language as existing axis-segmented.
 * Changes DATA/PERMISSIONS only; does not restyle the shell.
 */
export function WorkspaceSwitcher({
  onPersonalNeedAuth,
}: {
  /** Navigate to owner auth when switching to personal without a session. */
  onPersonalNeedAuth?: () => void;
}) {
  const { mode, setMode, personalOwnerId } = useWorkspace();

  const select = (next: WorkspaceMode) => {
    setMode(next);
    if (next === "personal" && !personalOwnerId && onPersonalNeedAuth) {
      onPersonalNeedAuth();
    }
  };

  return (
    <div
      className="axis-segmented nio-workspace-switcher"
      role="group"
      aria-label="Workspace"
    >
      <button
        type="button"
        aria-pressed={mode === "nishanth_public"}
        title="View Nishanth's live mainnet agent (read-only)"
        onClick={() => select("nishanth_public")}
      >
        <Eye size={14} strokeWidth={1.8} />
        <span>Nishanth&apos;s agent</span>
      </button>
      <button
        type="button"
        aria-pressed={mode === "personal"}
        title="Set up or inspect your own agent"
        onClick={() => select("personal")}
      >
        <UserRound size={14} strokeWidth={1.8} />
        <span>Set up your own</span>
      </button>
    </div>
  );
}

export function LiveDataChrome() {
  const { isPublic, live } = useWorkspace();

  if (!isPublic) return null;

  const quality = live.mandate?.data_quality;
  const isLastGood =
    quality === "LAST_KNOWN_GOOD" || Boolean(live.mandate?.stale);
  // Never label cached / last-known-good as FRESH or LIVE.
  const tone = isLastGood
    ? "nio-badge-warn"
    : live.status === "ready" && live.mandate?.fresh
      ? "nio-badge-success"
      : live.status === "ready"
        ? "nio-badge-idle"
        : live.status === "stale"
          ? "nio-badge-warn"
          : live.status === "error"
            ? "nio-badge-danger"
            : "nio-badge-idle";

  const label = isLastGood
    ? "LAST KNOWN GOOD"
    : live.status === "ready" && live.mandate?.fresh
      ? "LIVE"
      : live.status === "ready"
        ? "CACHED"
        : live.status === "stale"
          ? "STALE"
          : live.status === "error"
            ? "API ERROR"
            : live.status === "loading"
              ? "LOADING"
              : "IDLE";

  return (
    <div className="nio-live-chrome axis-actions" style={{ flexWrap: "wrap", gap: 8 }}>
      <span className={`nio-badge ${tone}`}>{label}</span>
      <span className="axis-supporting">
        Updated {formatLastUpdated(live.lastUpdated)}
        {live.error ? ` · ${live.error}` : ""}
      </span>
      <button
        type="button"
        className="axis-button secondary"
        onClick={() => void live.refresh()}
        disabled={live.status === "loading"}
      >
        Refresh
      </button>
    </div>
  );
}
