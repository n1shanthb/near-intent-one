import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  Bot,
  FileSearch,
  FileText,
  FolderLock,
  Globe2,
  KeyRound,
  Layers2,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  ScanSearch,
  Settings,
  Shield,
  UserRound,
  Wallet,
  WalletCards,
  X,
} from "lucide-react";
import { NioBrandMark } from "./NioLogo";
import { NetworkIndicator } from "./NetworkIndicator";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { useWorkspace } from "../../state/WorkspaceContext";
import type { NavId } from "./nav";

type LinkDef = {
  id: NavId;
  label: string;
  icon: typeof Activity;
  separated?: boolean;
  publicOnly?: boolean;
  personalOnly?: boolean;
};

const BASE_LINKS: LinkDef[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "agent", label: "AI Agent", icon: Bot },
  { id: "portfolio", label: "Portfolio", icon: WalletCards },
  { id: "mandate", label: "Mandate", icon: FileText },
  { id: "activity", label: "Transactions", icon: Activity },
  { id: "verify", label: "Proof & Verify", icon: FileSearch },
  { id: "inspect", label: "Inspect agent", icon: ScanSearch },
  { id: "security", label: "Security", icon: Shield, separated: true },
  { id: "owner", label: "Owner auth", icon: KeyRound, personalOnly: true },
  { id: "my-portfolio", label: "My Portfolio", icon: UserRound, personalOnly: true },
  { id: "evidence", label: "Historical evidence", icon: FolderLock },
  { id: "mainnet", label: "Mainnet evidence", icon: Globe2 },
  { id: "settings", label: "Settings", icon: Settings },
];

const titles: Partial<Record<NavId, string>> = {
  overview: "Overview",
  portfolio: "Portfolio",
  owner: "Owner authentication",
  "my-portfolio": "My Portfolio",
  agent: "AI Agent",
  mandate: "Mandate",
  verify: "Proof & Verify",
  inspect: "Public agent inspector",
  activity: "Transactions",
  security: "Security",
  evidence: "Historical evidence",
  mainnet: "Mainnet evidence",
  settings: "Settings",
  funds: "Deposit / Withdraw",
};

export function WorkspaceShell({
  active,
  onNav,
  onHome,
  walletSlot,
  demoStatus,
  healthNetwork,
  children,
}: {
  active: NavId;
  onNav: (id: NavId) => void;
  onHome: () => void;
  walletSlot?: ReactNode;
  demoStatus?: string;
  /** Live API-reported network (testnet|mainnet) — drives the real indicator. */
  healthNetwork?: string | null;
  children: ReactNode;
}) {
  const { isPublic, identities } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const sidebar = useRef<HTMLElement>(null);
  const menu = useRef<HTMLButtonElement>(null);
  const current = titles[active] ?? "Workspace";

  const links = useMemo(
    () =>
      BASE_LINKS.filter((item) => {
        if (item.personalOnly && isPublic) return false;
        if (item.publicOnly && !isPublic) return false;
        return true;
      }),
    [isPublic]
  );

  const networkForIndicator = isPublic ? "mainnet" : healthNetwork;
  const footerNetwork = isPublic
    ? "MPC · Intents · mainnet"
    : "MPC · Intents · personal setup";

  useEffect(() => {
    if (!open) return;
    const viewport = window.matchMedia("(max-width: 900px)");
    if (!viewport.matches) return;
    const onViewportChange = () => {
      if (!viewport.matches) setOpen(false);
    };
    viewport.addEventListener("change", onViewportChange);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        menu.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      viewport.removeEventListener("change", onViewportChange);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  return (
    <div
      className="axis-layout"
      data-collapsed={collapsed}
      data-workspace={isPublic ? "nishanth_public" : "personal"}
    >
      <a className="axis-skip" href="#main">
        Skip to content
      </a>
      <aside
        id="axis-workspace-sidebar"
        ref={sidebar}
        className={open ? "axis-sidebar open" : "axis-sidebar"}
        aria-label="Workspace sidebar"
      >
        <button
          type="button"
          className="axis-brand"
          aria-label="NIO home"
          onClick={() => {
            setOpen(false);
            onHome();
          }}
        >
          <NioBrandMark />
          <span className="axis-brand-label">
            nio
            <span className="axis-brand-period">.</span>
          </span>
        </button>
        <div className="nio-sidebar-switcher">
          <WorkspaceSwitcher onPersonalNeedAuth={() => onNav("owner")} />
        </div>
        <nav aria-label="Primary">
          {links.map((item) => (
            <button
              type="button"
              key={item.id}
              title={collapsed ? item.label : undefined}
              className={item.separated ? "axis-nav-separated" : undefined}
              aria-current={active === item.id ? "page" : undefined}
              onClick={() => {
                setOpen(false);
                onNav(item.id);
              }}
            >
              <item.icon size={18} strokeWidth={1.75} />
              <span className="axis-nav-label">{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="axis-sidebar-footer">
          <span className="axis-sidebar-footer-mark">
            <Layers2 size={17} />
          </span>
          <div>
            <b>Powered by NEAR</b>
            <span>{footerNetwork}</span>
            {isPublic && identities.policy ? (
              <span className="mono" style={{ fontSize: 11, opacity: 0.85 }}>
                {identities.policy}
              </span>
            ) : null}
          </div>
        </div>
      </aside>
      <div className="axis-main">
        <header className="axis-topbar">
          <div className="axis-topbar-start">
            <button
              type="button"
              className="axis-icon-button axis-collapse-button"
              aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
              aria-expanded={!collapsed}
              onClick={() => setCollapsed((v) => !v)}
            >
              {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
            </button>
            <button
              ref={menu}
              type="button"
              className="axis-icon-button axis-mobile-menu"
              aria-label={open ? "Close navigation" : "Open navigation"}
              aria-controls="axis-workspace-sidebar"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? <X size={20} /> : <Menu size={20} />}
            </button>
            <div className="axis-topbar-label">
              Workspace<span>/</span>
              <b>{current}</b>
            </div>
          </div>
          <div className="axis-header-actions">
            <div className="nio-topbar-switcher">
              <WorkspaceSwitcher onPersonalNeedAuth={() => onNav("owner")} />
            </div>
            <NetworkIndicator healthNetwork={networkForIndicator} compact />
            {demoStatus && !isPublic ? (
              <span className="axis-network-chip" title="Demo status">
                <Bot size={16} strokeWidth={1.8} />
                <span>{demoStatus}</span>
              </span>
            ) : null}
            {walletSlot}
          </div>
        </header>
        <main id="main" className="axis-content">
          {children}
        </main>
      </div>
      {open ? (
        <button
          type="button"
          className="axis-mobile-shade"
          aria-label="Dismiss navigation"
          onClick={() => {
            setOpen(false);
            menu.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

export function WalletControl({
  loading,
  accountId,
  onConnect,
  onDisconnect,
}: {
  loading: boolean;
  accountId: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const short =
    accountId && accountId.length > 18
      ? `${accountId.slice(0, 8)}…${accountId.slice(-6)}`
      : accountId;
  return (
    <div className={`axis-wallet-control ${accountId ? "connected" : ""}`}>
      <button
        type="button"
        className="axis-wallet-button"
        aria-label={accountId ? `Wallet ${accountId}` : "Connect wallet"}
        onClick={() => void onConnect()}
        disabled={loading}
      >
        <span className="axis-wallet-symbol">
          {loading ? (
            <LoaderCircle size={17} className="animate-spin" />
          ) : (
            <Wallet size={17} strokeWidth={1.8} />
          )}
        </span>
        <span>{loading ? "Connecting…" : short || "Connect wallet"}</span>
      </button>
      {accountId ? (
        <button
          type="button"
          className="axis-wallet-disconnect"
          aria-label="Disconnect"
          onClick={onDisconnect}
        >
          <LogOut size={17} strokeWidth={1.8} />
        </button>
      ) : null}
    </div>
  );
}
