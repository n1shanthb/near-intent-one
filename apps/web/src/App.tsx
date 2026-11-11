import { lazy, Suspense, useEffect, useState } from "react";
import { useNearWallet } from "near-connect-hooks";
import { ProductSessionProvider, useProductSession } from "./state/ProductSession";
import { OwnerSessionProvider, useOwnerSession } from "./state/OwnerSession";
import { Landing } from "./components/nio/Landing";
import { OverviewPage } from "./components/nio/OverviewPage";
import { AgentWorkspace } from "./components/nio/AgentWorkspace";
import { PortfolioPage } from "./components/nio/PortfolioPage";
import { OwnerAuthPage } from "./components/nio/OwnerAuthPage";
import { MyPortfolioPage } from "./components/nio/MyPortfolioPage";
import { EvidencePage } from "./components/nio/EvidencePage";
import { TransactionsPage } from "./components/nio/TransactionsPage";
import { MandatePage } from "./components/nio/MandatePage";
import { SecurityPage } from "./components/nio/SecurityPage";
import { WorkspaceShell, WalletControl } from "./components/nio/WorkspaceShell";
import { pathToNav, WORKSPACE_PATH, type NavId } from "./components/nio/nav";
import { Funds } from "./components/Funds";
import { fetchDemoStatus } from "./adapters/gatej";
import { isPublicLiveAiEnabled } from "./lib/publicDemo";
import { publicApiLabel } from "./lib/apiBase";

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
  const { verified, session, clearOwner } = useOwnerSession();

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
          accountId={
            verified
              ? session?.account_id ?? signedAccountId ?? null
              : signedAccountId ?? null
          }
          onConnect={() => {
            if (!verified) onNav("owner");
            else void signIn();
          }}
          onDisconnect={() => {
            clearSession();
            void clearOwner();
            void signOut();
          }}
        />
      }
    >
      {nav === "overview" && (
        <OverviewPage
          onNav={onNav}
          gateIStatus={gateI.status}
          gateIDetail={gateI.detail}
          demoLabel={demoChip}
        />
      )}
      {nav === "portfolio" && <PortfolioPage onNav={onNav} />}
      {nav === "owner" && <OwnerAuthPage onNav={onNav} />}
      {nav === "my-portfolio" && <MyPortfolioPage onNav={onNav} />}
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
      {nav === "agent" && <AgentWorkspace onNav={onNav} />}
      {(nav === "mandate" || nav === "policies") && <MandatePage onNav={onNav} />}
      {nav === "activity" && <TransactionsPage onNav={onNav} />}
      {nav === "evidence" && <EvidencePage />}
      {nav === "security" && (
        <>
          <SecurityPage onNav={onNav} onOpenLedger={() => onNav("ledger")} />
          <Suspense fallback={<p className="axis-supporting">Loading Ledger wizard…</p>}>
            <div className="legacy-embed" style={{ marginTop: 16 }}>
              <LedgerWizard />
            </div>
          </Suspense>
        </>
      )}
      {nav === "settings" && (
        <section className="axis-panel">
          <div className="axis-panel-heading">
            <h2>Settings</h2>
          </div>
          <p>
            Public demo mode keeps OpenRouter keys and Gate K signing on the trusted host.
            Wallet connection is optional for evidence and Live AI dry-run.
          </p>
          <p className="axis-supporting mono">
            {publicApiLabel()} · network {import.meta.env.VITE_NETWORK || "testnet"}
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
      <OwnerSessionProvider>
        <AppInner />
      </OwnerSessionProvider>
    </ProductSessionProvider>
  );
}
