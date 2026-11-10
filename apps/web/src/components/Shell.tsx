import type { ReactNode } from "react";
import { JourneyStrip } from "./JourneyStrip";

export type NavId =
  | "welcome"
  | "portfolio"
  | "funds"
  | "demo"
  | "overview"
  | "agent"
  | "policies"
  | "predict"
  | "activity"
  | "security"
  | "ledger";

const NAV: { id: NavId; label: string; group?: string }[] = [
  { id: "welcome", label: "Welcome", group: "product" },
  { id: "portfolio", label: "Portfolio", group: "product" },
  { id: "funds", label: "Deposit / Withdraw", group: "product" },
  { id: "policies", label: "Policies", group: "product" },
  { id: "agent", label: "Agent", group: "product" },
  { id: "activity", label: "Activity", group: "product" },
  { id: "security", label: "Security", group: "product" },
  { id: "ledger", label: "Ledger setup", group: "product" },
  { id: "demo", label: "Judge demo", group: "evidence" },
  { id: "overview", label: "Overview", group: "evidence" },
  { id: "predict", label: "Predict (illustrative)", group: "evidence" },
];

export function Shell({
  active,
  onNav,
  mode,
  onMode,
  walletSlot,
  gateISlot,
  children,
}: {
  active: NavId;
  onNav: (id: NavId) => void;
  mode: "verified" | "simulation" | "live";
  onMode: (m: "verified" | "simulation" | "live") => void;
  walletSlot: ReactNode;
  gateISlot?: ReactNode;
  children: ReactNode;
}) {
  const product = NAV.filter((n) => n.group === "product");
  const evidence = NAV.filter((n) => n.group === "evidence");

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
          <p className="nav-group">Product (testnet)</p>
          {product.map((item) => (
            <button
              key={item.id}
              type="button"
              className={active === item.id ? "nav active" : "nav"}
              onClick={() => onNav(item.id)}
            >
              {item.label}
            </button>
          ))}
          <p className="nav-group">Recorded / illustrative</p>
          {evidence.map((item) => (
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
          {gateISlot}
          <label className="mode-label">
            Evidence mode
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
            {mode === "verified" && "Hashes from Gates B–H evidence packs."}
            {mode === "simulation" && "Predict only — never VERIFIED P/L."}
            {mode === "live" && "Read-only RPC / dry quotes. No funded trades."}
          </p>
          {walletSlot}
        </div>
      </aside>
      <div className="main-col">
        <header className="topbar">
          <div>
            <p className="eyebrow">NEAR TESTNET ONLY · user product + judge evidence</p>
            <h1>{NAV.find((n) => n.id === active)?.label}</h1>
          </div>
          <span className={`mode-pill mode-${mode}`}>{mode}</span>
        </header>
        {["welcome", "portfolio", "funds", "policies", "agent", "activity", "security"].includes(
          active
        ) ? (
          <JourneyStrip active={active} onNav={onNav} />
        ) : null}
        <div className="content">{children}</div>
      </div>
    </div>
  );
}
