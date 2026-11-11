import { Layers2, ShieldAlert } from "lucide-react";
import {
  CAPABILITY_LABELS,
  workspaceNetworkContext,
  type WorkspaceNetworkContext,
} from "../../lib/network";
import {
  MAINNET_EVIDENCE,
  hasVerifiedMainnetContract,
} from "../../data/mainnetEvidence";

export function NetworkIndicator({
  healthNetwork,
  compact = false,
}: {
  healthNetwork?: string | null;
  compact?: boolean;
}) {
  const ctx = workspaceNetworkContext(healthNetwork);
  const mainnetReady = hasVerifiedMainnetContract();

  if (compact) {
    return (
      <>
        <span
          className="axis-network-chip"
          title={`Active workspace network: ${ctx.label}`}
          data-network={ctx.active}
        >
          <Layers2 size={16} strokeWidth={1.8} />
          <span>{ctx.label}</span>
        </span>
        <span
          className={`axis-network-chip ${mainnetReady ? "nio-network-mainnet-ready" : "nio-network-mainnet-pending"}`}
          title={
            mainnetReady
              ? "Independently verified NIO mainnet contract proof is available"
              : "NIO mainnet contract proof not yet verified by Chat 1"
          }
        >
          <ShieldAlert size={16} strokeWidth={1.8} />
          <span>{mainnetReady ? "Mainnet proof" : "Mainnet pending"}</span>
        </span>
      </>
    );
  }

  return <NetworkStatusPanel ctx={ctx} />;
}

export function NetworkStatusPanel({
  ctx,
}: {
  ctx?: WorkspaceNetworkContext;
}) {
  const network = ctx ?? workspaceNetworkContext();
  const ev = MAINNET_EVIDENCE;
  const mainnetReady = hasVerifiedMainnetContract(ev);

  return (
    <section className="axis-panel nio-network-panel">
      <div className="axis-panel-heading">
        <h2>Network status</h2>
        <span
          className={`nio-badge ${
            network.active === "mainnet" ? "nio-badge-warn" : "nio-badge-recorded"
          }`}
        >
          ACTIVE · {network.label.toUpperCase()}
        </span>
      </div>
      <dl className="nio-kv">
        <div>
          <dt>Public demo / Live AI</dt>
          <dd>
            {network.label} · dry-run only ·{" "}
            <span className="mono">may_sign=false</span>
          </dd>
        </div>
        <div>
          <dt>NIO mainnet proof</dt>
          <dd>
            {mainnetReady ? (
              <span className="nio-badge nio-badge-success">VERIFIED</span>
            ) : (
              <span className="nio-badge nio-badge-idle">AWAITING CHAT 1</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Explorer</dt>
          <dd className="mono">{network.nearblocksBase}</dd>
        </div>
      </dl>
      <div className="nio-capability-grid" aria-label="Mainnet capability matrix">
        {(Object.keys(CAPABILITY_LABELS) as (keyof typeof CAPABILITY_LABELS)[]).map(
          (key) => {
            const on = ev.capabilities[key];
            return (
              <div key={key} data-on={on ? "1" : "0"}>
                <span
                  className={`nio-badge ${on ? "nio-badge-success" : "nio-badge-idle"}`}
                >
                  {on ? "YES" : "NO"}
                </span>
                <strong>{CAPABILITY_LABELS[key]}</strong>
              </div>
            );
          }
        )}
      </div>
      <p className="axis-supporting" style={{ marginTop: 12 }}>
        Network chips reflect live workspace context and independently verified
        mainnet evidence — not a cosmetic text toggle.
      </p>
    </section>
  );
}
