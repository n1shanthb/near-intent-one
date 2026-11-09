import type { ScenarioPack } from "./types";

/**
 * Explicitly labeled ILLUSTRATIVE scenario pack.
 * Not historical Tidepool fills. Used for deterministic Predict demos.
 */
function days(n: number, start = "2026-10-01"): ScenarioPointLike[] {
  const out: ScenarioPointLike[] = [];
  const d0 = new Date(start + "T00:00:00Z");
  let mid = 100;
  for (let i = 0; i < n; i++) {
    const d = new Date(d0.getTime() + i * 86400000);
    // Deterministic pseudo-walk from day index (no Math.random).
    mid = mid + ((i * 37) % 7) - 3 + (i % 5 === 0 ? 1.5 : 0);
    out.push({ t: d.toISOString().slice(0, 10), mid: Number(mid.toFixed(4)) });
  }
  return out;
}

type ScenarioPointLike = { t: string; mid: number };

const series30 = days(30);
const series7 = series30.slice(-7);

function signalsFrom(series: ScenarioPointLike[]) {
  const signals = [];
  for (let i = 1; i < series.length; i++) {
    const delta = series[i].mid - series[i - 1].mid;
    if (Math.abs(delta) < 1.2) continue;
    signals.push({
      t: series[i].t,
      side: (delta < 0 ? "buy" : "sell") as "buy" | "sell",
      sizeUsd: 8 + ((i * 3) % 12),
      note: `Deterministic signal from mid move ${delta.toFixed(2)}`,
    });
  }
  return signals;
}

export const ILLUSTRATIVE_30D: ScenarioPack = {
  id: "illustrative-synth-v1",
  label: "Illustrative synthetic mid (v1)",
  provenance:
    "Synthetic deterministic mid series for UX demo. NOT live market history. NOT Tidepool quotes.",
  kind: "illustrative",
  feeBps: 20,
  slippageBpsAssumption: 10,
  series: series30,
  signals: signalsFrom(series30),
};

export const ILLUSTRATIVE_7D: ScenarioPack = {
  ...ILLUSTRATIVE_30D,
  id: "illustrative-synth-v1-7d",
  series: series7,
  signals: signalsFrom(series7),
};

export function packForHorizon(horizon: "7d" | "30d"): ScenarioPack {
  return horizon === "7d" ? ILLUSTRATIVE_7D : ILLUSTRATIVE_30D;
}
