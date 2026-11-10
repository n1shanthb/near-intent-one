import { lazy, Suspense, useEffect, useState } from "react";
import { useNearWallet } from "near-connect-hooks";
import { ProductSessionProvider, useProductSession } from "./state/ProductSession";
import { Landing } from "./components/nio/Landing";
import { OverviewPage } from "./components/nio/OverviewPage";
import { AgentWorkspace } from "./components/nio/AgentWorkspace";
import { WorkspaceShell, WalletControl } from "./components/nio/WorkspaceShell";
import { pathToNav, WORKSPACE_PATH, type NavId } from "./components/nio/nav";
import { Portfolio } from "./components/Portfolio";
import { Funds } from "./components/Funds";
import { Policies } from "./components/Policies";
import { Activity } from "./components/Activity";
import { Security } from "./components/Security";
import { fetchDemoStatus } from "./adapters/gatej";
import { isPublicLiveAiEnabled } from "./lib/publicDemo";

const LedgerWizard = lazy(async () => {
  await import("./polyfills");
  const mod = await import("./components/LedgerWizard");
  return { default: mod.LedgerWizard };
});

function AppInner() {
  const [nav, setNav] = useState<NavId>(() => pathToNav(window.location.pathname));
  const [demoChip, setDemoChip] = useState("demo…");
  const { signedAccountId, signIn, signOut, loading } = useNearWallet();
  const { gateI, syncOwner, clearSession } = useProductSession();

  useEffect(() => {
    syncOwner(signedAccountId ?? null);
  }, [signedAccountId, syncOwner]);

  useEffect(() => {
    const onPop = () => setNav(pathToNav(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (!isPublicLiveAiEnabled()) {
      setDemoChip("live AI off");
      return;
    }
    void fetchDemoStatus().then((s) => {
      if (!s.ok || s.kill_switch) setDemoChip("demo paused");
      else setDemoChip(`AI ${s.remaining?.global_calls ?? "—"} left`);
    });
  }, [nav]);

  const onNav = (id: NavId) => {
    setNav(id);
    const path = WORKSPACE_PATH[id] ?? "/";
    window.history.pushState({}, "", path);
  };

  if (nav === "landing" || nav === "welcome") {
    return <Landing onOpen={onNav} />;
  }

  return (
    <WorkspaceShell
      active={nav}
      onNav={onNav}
      onHome={() => onNav("landing")}
      demoStatus={demoChip}
      walletSlot={
        <WalletControl
          loading={loading}
          accountId={signedAccountId ?? null}
          onConnect={() => void signIn()}
          onDisconnect={() => {
            clearSession();
            void signOut();
          }}
        />
      }
    >
      {nav === "overview" && (
        <OverviewPage
          onNav={onNav}
          gateIStatus={gateI.status}
          demoLabel={demoChip}
        />
      )}
      {nav === "portfolio" && (
        <div className="legacy-embed">
          <Portfolio
            onNav={(id) =>
              onNav(
                id === "funds"
                  ? "funds"
                  : id === "policies"
                    ? "mandate"
                    : id === "agent"
                      ? "agent"
                      : "overview"
              )
            }
          />
        </div>
      )}
      {nav === "funds" && (
        <div className="legacy-embed">
          <Funds
            onNav={(id) =>
              onNav(
                id === "portfolio"
                  ? "portfolio"
                  : id === "welcome"
                    ? "landing"
                    : "overview"
              )
            }
          />
        </div>
      )}
      {nav === "agent" && <AgentWorkspace />}
      {(nav === "mandate" || nav === "policies") && (
        <div className="legacy-embed">
          <Policies onOpenLedger={() => onNav("security")} />
        </div>
      )}
      {(nav === "activity" || nav === "evidence") && (
        <div className="legacy-embed">
          <Activity />
        </div>
      )}
      {nav === "security" && (
        <div className="legacy-embed">
          <Security
            onOpenLedger={() => onNav("security")}
            onOpenFunds={() => onNav("funds")}
          />
          <Suspense fallback={<p className="axis-supporting">Loading Ledger wizard…</p>}>
            <LedgerWizard />
          </Suspense>
        </div>
      )}
      {nav === "settings" && (
        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>Settings</h2>
          </div>
          <p>
            Public demo mode keeps OpenRouter keys and Gate K signing on OCI.
            Wallet connection is optional for evidence and Live AI dry-run.
          </p>
          <p className="axis-supporting mono">
            API base · {import.meta.env.VITE_GATE_I_API_BASE || "/api/v1"} · network{" "}
            {import.meta.env.VITE_NETWORK || "testnet"}
          </p>
        </section>
      )}
      {nav === "ledger" && (
        <Suspense fallback={<p>Loading Ledger wizard…</p>}>
          <div className="legacy-embed">
            <LedgerWizard />
          </div>
        </Suspense>
      )}
    </WorkspaceShell>
  );
}

export default function App() {
  return (
    <ProductSessionProvider>
      <AppInner />
    </ProductSessionProvider>
  );
}
