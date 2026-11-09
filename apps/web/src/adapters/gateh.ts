/**
 * Gate H adapters — physical Ledger, upgrade authority, strategy.
 * Product consumes when available; never invent decision traces.
 */

export type StrategyDecisionLog = {
  input: string;
  choice: "trade" | "no-trade";
  rationale: string;
  policyResult: "permitted" | "rejected";
  outcome: string;
  source: "live_gate_h";
};

export interface GateHLedger {
  isConnected(): Promise<boolean>;
  isProven(): Promise<boolean>;
}

export interface GateHStrategy {
  getLatestDecision(): Promise<StrategyDecisionLog | null>;
}

export const gateHLedger: GateHLedger = {
  async isConnected() {
    return false;
  },
  async isProven() {
    return false;
  },
};

export const gateHStrategy: GateHStrategy = {
  async getLatestDecision() {
    return null;
  },
};
