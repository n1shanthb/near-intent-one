export type NavId =
  | "landing"
  | "overview"
  | "portfolio"
  | "my-portfolio"
  | "owner"
  | "agent"
  | "mandate"
  | "activity"
  | "security"
  | "evidence"
  | "mainnet"
  | "settings"
  | "funds"
  | "policies"
  | "welcome"
  | "demo"
  | "predict"
  | "ledger";

export const WORKSPACE_PATH: Partial<Record<NavId, string>> = {
  landing: "/",
  overview: "/overview",
  portfolio: "/portfolio",
  "my-portfolio": "/my-portfolio",
  owner: "/owner",
  agent: "/agent",
  mandate: "/mandate",
  activity: "/transactions",
  evidence: "/evidence",
  mainnet: "/mainnet",
  security: "/security",
  settings: "/settings",
  funds: "/funds",
  policies: "/mandate",
  welcome: "/",
  demo: "/evidence",
  predict: "/overview",
  ledger: "/security",
};

export function pathToNav(pathname: string): NavId {
  const map: Record<string, NavId> = {
    "/": "landing",
    "/overview": "overview",
    "/portfolio": "portfolio",
    "/my-portfolio": "my-portfolio",
    "/owner": "owner",
    "/agent": "agent",
    "/mandate": "mandate",
    "/policies": "mandate",
    "/transactions": "activity",
    "/activity": "activity",
    "/evidence": "evidence",
    "/mainnet": "mainnet",
    "/security": "security",
    "/settings": "settings",
    "/funds": "funds",
    "/welcome": "landing",
  };
  if (map[pathname]) return map[pathname];
  for (const [path, id] of Object.entries(map)) {
    if (path !== "/" && pathname.endsWith(path)) return id;
  }
  return "landing";
}
