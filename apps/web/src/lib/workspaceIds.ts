/** Fixed identities for the public Nishanth mainnet showcase workspace. */
export const NISHANTH_PUBLIC = {
  owner: "nishanthb.near",
  agent: "agent.nishanthb.near",
  policy: "policy.nishanthb.near",
  portfolio_id: "nio-mainnet-v1",
  network: "mainnet" as const,
} as const;

export type WorkspaceMode = "nishanth_public" | "personal";

export const WORKSPACE_STORAGE_KEY = "nio.workspace.mode.v1";

export function isNishanthAccount(accountId: string | null | undefined): boolean {
  if (!accountId) return false;
  const id = accountId.toLowerCase();
  return (
    id === NISHANTH_PUBLIC.owner ||
    id === NISHANTH_PUBLIC.agent ||
    id === NISHANTH_PUBLIC.policy
  );
}
