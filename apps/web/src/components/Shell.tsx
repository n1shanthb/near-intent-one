import type { ReactNode } from "react";

export type NavId =
  | "demo"
  | "overview"
  | "agent"
  | "policies"
  | "predict"
  | "activity"
  | "security";

const NAV: { id: NavId; label: string }[] = [
  { id: "demo", label: "Judge demo" },
  { id: "overview", label: "Overview" },
  { id: "agent", label: "Agent" },
  { id: "policies", label: "Policies" },
  { id: "predict", label: "Predict" },
  { id: "activity", label: "Evidence" },
  { id: "security", label: "Security" },
];

export function Shell({
  active,
  onNav,
  mode,
  onMode,
  walletSlot,
  children,
}: {
  active: NavId;
  onNav: (id: NavId) => void;
  mode: "verified" | "simulation" | "live";
  onMode: (m: "verified" | "simulation" | "live") => void;
  walletSlot: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="mark">NIO</span>
          <div>
            <strong>near-intent-one</strong>
            <p>Hardware sets rules. AI trades. NEAR enforces.</p>
          </div>
        </div>
        <nav>
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={active === item.id ? "nav active" : "nav"}
              onClick={() => onNav(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <label className="mode-label">
            Data mode
            <select
              value={mode}
              onChange={(e) =>
                onMode(e.target.value as "verified" | "simulation" | "live")
              }
            >
              <option value="verified">Recorded verified evidence</option>
              <option value="simulation">Illustrative simulation</option>
              <option value="live">Current live reads</option>
            </select>
          </label>
          <p className="muted small mode-hint">
            {mode === "verified" && "Hashes from Gates B–G evidence packs."}
            {mode === "simulation" && "Predict only — never VERIFIED P/L."}
            {mode === "live" && "Read-only RPC / dry quotes. No funded trades."}
          </p>
          {walletSlot}
        </div>
      </aside>
      <div className="main-col">
        <header className="topbar">
          <div>
            <p className="eyebrow">NEAR HACKATHON · defi · security · agents</p>
            <h1>{NAV.find((n) => n.id === active)?.label}</h1>
          </div>
          <span className={`mode-pill mode-${mode}`}>{mode}</span>
        </header>
        <div className="content">{children}</div>
      </div>
    </div>
  );
}
