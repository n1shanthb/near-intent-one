import { lazy, Suspense, useEffect, useState } from "react";
import { useNearWallet } from "near-connect-hooks";
import { Shell, type NavId } from "./components/Shell";
import { Welcome } from "./components/Welcome";
import { Portfolio } from "./components/Portfolio";
import { Funds } from "./components/Funds";
import { Demo } from "./components/Demo";
import { Overview } from "./components/Overview";
import { AgentPanel } from "./components/Agent";
import { Policies } from "./components/Policies";
import { PredictView } from "./components/Predict";
import { Activity } from "./components/Activity";
import { Security } from "./components/Security";
import { ProductSessionProvider, useProductSession } from "./state/ProductSession";

const LedgerWizard = lazy(async () => {
  await import("./polyfills");
  const mod = await import("./components/LedgerWizard");
  return { default: mod.LedgerWizard };
});

function pathIsLedgerWizard(pathname: string): boolean {
  return (
    pathname === "/setup/ledger" ||
    pathname === "/security/ledger" ||
    pathname.endsWith("/setup/ledger") ||
    pathname.endsWith("/security/ledger")
  );
}

function pathToNav(pathname: string): NavId | null {
  if (pathIsLedgerWizard(pathname)) return "ledger";
  const map: Record<string, NavId> = {
    "/welcome": "welcome",
    "/portfolio": "portfolio",
    "/funds": "funds",
    "/policies": "policies",
    "/agent": "agent",
    "/activity": "activity",
    "/security": "security",
    "/demo": "demo",
    "/overview": "overview",
    "/predict": "predict",
  };
  if (map[pathname]) return map[pathname];
  for (const [path, id] of Object.entries(map)) {
    if (pathname.endsWith(path)) return id;
  }
  return null;
}

function AppInner() {
  const fromPath = pathToNav(window.location.pathname);
  const [nav, setNav] = useState<NavId>(fromPath ?? "welcome");
  const [mode, setMode] = useState<"verified" | "simulation" | "live">(
    "verified"
  );
  const { signedAccountId, signIn, signOut, loading } = useNearWallet();
  const { gateI, syncOwner, clearSession } = useProductSession();

  useEffect(() => {
    syncOwner(signedAccountId ?? null);
  }, [signedAccountId, syncOwner]);

  useEffect(() => {
    const onPop = () => {
      const id = pathToNav(window.location.pathname);
      if (id) setNav(id);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const onNav = (id: NavId) => {
    setNav(id);
    const pathMap: Record<NavId, string> = {
      ledger: "/setup/ledger",
      welcome: "/welcome",
      portfolio: "/portfolio",
      funds: "/funds",
      policies: "/policies",
      agent: "/agent",
      activity: "/activity",
      security: "/security",
      demo: "/demo",
      overview: "/overview",
      predict: "/predict",
    };
    window.history.pushState({}, "", pathMap[id]);
  };

  const walletConnected = Boolean(signedAccountId);

  return (
    <Shell
      active={nav}
      onNav={onNav}
      mode={mode}
      onMode={setMode}
      gateISlot={
        <p className={`gate-pill gate-${gateI.status}`}>
          Gate I · {gateI.status}
        </p>
      }
      walletSlot={
        loading ? (
          <span className="muted small">Wallet…</span>
        ) : signedAccountId ? (
          <button
            type="button"
            className="ghost nav"
            onClick={() => {
              clearSession();
              void signOut();
            }}
          >
            {signedAccountId}
          </button>
        ) : (
          <button type="button" className="ghost nav" onClick={() => void signIn()}>
            Connect NEAR Wallet
          </button>
        )
      }
    >
      {nav === "welcome" && <Welcome onNav={onNav} />}
      {nav === "portfolio" && <Portfolio onNav={onNav} />}
      {nav === "funds" && <Funds onNav={onNav} />}
      {nav === "demo" && (
        <Demo
          onNav={onNav}
          onSignIn={() => void signIn()}
          walletConnected={walletConnected}
        />
      )}
      {nav === "overview" && (
        <Overview
          mode={mode}
          onNav={onNav}
          onSignIn={() => void signIn()}
          walletConnected={walletConnected}
        />
      )}
      {nav === "agent" && <AgentPanel />}
      {nav === "policies" && <Policies onOpenLedger={() => onNav("ledger")} />}
      {nav === "predict" && <PredictView />}
      {nav === "activity" && <Activity />}
      {nav === "security" && (
        <Security
          onOpenLedger={() => onNav("ledger")}
          onOpenFunds={() => onNav("funds")}
        />
      )}
      {nav === "ledger" && (
        <Suspense fallback={<p className="muted">Loading Ledger wizard…</p>}>
          <LedgerWizard />
        </Suspense>
      )}
    </Shell>
  );
}

export default function App() {
  return (
    <ProductSessionProvider>
      <AppInner />
    </ProductSessionProvider>
  );
}
