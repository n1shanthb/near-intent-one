import { useProductSession } from "../state/ProductSession";

export function GateIBanner({ action }: { action?: string }) {
  const { gateI, refreshGateI } = useProductSession();
  if (gateI.status === "available") {
    return (
      <p className="banner banner-ok">
        Gate I online · {gateI.detail}
        <button type="button" className="ghost tiny" onClick={() => void refreshGateI()}>
          Refresh
        </button>
      </p>
    );
  }
  return (
    <div className="banner banner-block" role="status">
      <strong>Gate I unavailable</strong>
      <p>
        {action ? `${action} is blocked until Chat 1 hosts Gate I. ` : null}
        {gateI.detail}
      </p>
      <p className="muted small">
        Set <span className="mono">VITE_GATE_I_API_BASE</span> when the API is live.
        Judge demo evidence stays available under Recorded verified mode.
      </p>
      <button type="button" className="ghost" onClick={() => void refreshGateI()}>
        Retry health check
      </button>
    </div>
  );
}
