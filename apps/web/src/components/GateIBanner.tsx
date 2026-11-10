import { useProductSession } from "../state/ProductSession";

export function GateIBanner({ action }: { action?: string }) {
  const { gateI, refreshGateI } = useProductSession();

  if (gateI.status === "available") {
    return (
      <p className="banner banner-ok">
        API connected · {gateI.detail}
        <button type="button" className="ghost tiny" onClick={() => void refreshGateI()}>
          Refresh
        </button>
      </p>
    );
  }

  if (gateI.status === "degraded") {
    return (
      <div className="banner banner-warn" role="status">
        <strong>API degraded</strong>
        <p>{gateI.detail}</p>
        <button type="button" className="ghost" onClick={() => void refreshGateI()}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="banner banner-block" role="status">
      <strong>Live API temporarily unreachable</strong>
      <p>
        {action
          ? `${action} requires a live owner session and is unavailable while the API is unreachable. `
          : null}
        {gateI.detail}
      </p>
      <p className="muted small">
        Personal portfolio management requires an authenticated owner session and is
        unavailable in public demo mode. Recorded evidence and historical proofs stay
        visible without a wallet.
      </p>
      <button type="button" className="ghost" onClick={() => void refreshGateI()}>
        Retry health check
      </button>
    </div>
  );
}
