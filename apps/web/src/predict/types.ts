import type { CandidatePolicy } from "../policy/schema";

export type Horizon = "7d" | "30d";

export type ScenarioPoint = {
  t: string; // ISO day
  mid: number; // illustrative mid price index
};

export type SignalEvent = {
  t: string;
  side: "buy" | "sell";
  sizeUsd: number;
  note: string;
};

export type ScenarioPack = {
  id: string;
  label: string;
  provenance: string;
  kind: "illustrative";
  feeBps: number;
  slippageBpsAssumption: number;
  series: ScenarioPoint[];
  signals: SignalEvent[];
};

export type TradeOutcome = {
  t: string;
  side: "buy" | "sell";
  sizeUsd: number;
  permitted: boolean;
  rejectReason?: string;
  pnlUsd: number;
  costUsd: number;
};

export type PredictResult = {
  horizon: Horizon;
  policyLabel: string;
  provenance: string;
  kind: "illustrative";
  assumptions: string[];
  trades: TradeOutcome[];
  permittedCount: number;
  rejectedCount: number;
  simulatedPnlUsd: number;
  maxDrawdownPct: number;
  turnoverUsd: number;
  costsUsd: number;
  protections: string[];
  suggestions: string[];
};

export type CompareInput = {
  policyA: CandidatePolicy;
  policyB: CandidatePolicy;
  labelA?: string;
  labelB?: string;
  horizon: Horizon;
  pack: ScenarioPack;
};
