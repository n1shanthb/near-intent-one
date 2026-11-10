/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_POLICY_CONTRACT_ID?: string;
  readonly VITE_OWNER_ACCOUNT_ID?: string;
  readonly VITE_AGENT_ACCOUNT_ID?: string;
  /** Prefer `/api/v1` (Vite BFF) so GATE_I_API_KEY stays server-side. */
  readonly VITE_GATE_I_API_BASE?: string;
  readonly VITE_GATE_I_WITHDRAW_PROVEN?: string;
  /** Set true only after hosted API + SPA integration verified. */
  readonly VITE_GATE_J_ONCHAIN_MANDATE?: string;
  readonly VITE_NETWORK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
