import { lazy, Suspense, useEffect, useState } from "react";
import { useNearWallet } from "near-connect-hooks";
import { Shell, type NavId } from "./components/Shell";
import { Demo } from "./components/Demo";
import { Overview } from "./components/Overview";
import { AgentPanel } from "./components/Agent";
import { Policies } from "./components/Policies";
import { PredictView } from "./components/Predict";
import { Activity } from "./components/Activity";
import { Security } from "./components/Security";

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

export default function App() {
  const initialLedger = pathIsLedgerWizard(window.location.pathname);
  const [nav, setNav] = useState<NavId>(initialLedger ? "ledger" : "demo");
  const [mode, setMode] = useState<"verified" | "simulation" | "live">(
    "verified"
  );
  const { signedAccountId, signIn, signOut, loading } = useNearWallet();

  useEffect(() => {
    const onPop = () => {
      if (pathIsLedgerWizard(window.location.pathname)) setNav("ledger");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const onNav = (id: NavId) => {
    setNav(id);
    if (id === "ledger") {
      window.history.pushState({}, "", "/setup/ledger");
    } else if (window.location.pathname.includes("/ledger")) {
      window.history.pushState({}, "", "/");
    }
  };

  const walletConnected = Boolean(signedAccountId);

  return (
    <Shell
      active={nav}
      onNav={onNav}
      mode={mode}
      onMode={setMode}
      walletSlot={
        loading ? (
          <span className="muted small">Wallet…</span>
        ) : signedAccountId ? (
          <button type="button" className="ghost nav" onClick={() => void signOut()}>
            {signedAccountId}
          </button>
        ) : (
          <button type="button" className="ghost nav" onClick={() => void signIn()}>
            Connect NEAR Wallet
          </button>
        )
      }
    >
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
      {nav === "security" && <Security onOpenLedger={() => onNav("ledger")} />}
      {nav === "ledger" && (
        <Suspense fallback={<p className="muted">Loading Ledger wizard…</p>}>
          <LedgerWizard />
        </Suspense>
      )}
    </Shell>
  );
}
