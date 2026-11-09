import { useState } from "react";
import { useNearWallet } from "near-connect-hooks";
import { Shell, type NavId } from "./components/Shell";
import { Demo } from "./components/Demo";
import { Overview } from "./components/Overview";
import { AgentPanel } from "./components/Agent";
import { Policies } from "./components/Policies";
import { PredictView } from "./components/Predict";
import { Activity } from "./components/Activity";
import { Security } from "./components/Security";

export default function App() {
  const [nav, setNav] = useState<NavId>("demo");
  const [mode, setMode] = useState<"verified" | "simulation" | "live">(
    "verified"
  );
  const { signedAccountId, signIn, signOut, loading } = useNearWallet();

  return (
    <Shell
      active={nav}
      onNav={setNav}
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
            Connect NEAR
          </button>
        )
      }
    >
      {nav === "demo" && <Demo />}
      {nav === "overview" && <Overview mode={mode} />}
      {nav === "agent" && <AgentPanel />}
      {nav === "policies" && <Policies />}
      {nav === "predict" && <PredictView />}
      {nav === "activity" && <Activity />}
      {nav === "security" && <Security />}
    </Shell>
  );
}
