export type NavId =
  | "landing"
  | "overview"
  | "portfolio"
  | "agent"
  | "mandate"
  | "activity"
  | "security"
  | "evidence"
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
  agent: "/agent",
  mandate: "/mandate",
  activity: "/transactions",
  evidence: "/evidence",
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
    "/agent": "agent",
    "/mandate": "mandate",
    "/policies": "mandate",
    "/transactions": "activity",
    "/activity": "activity",
    "/evidence": "evidence",
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
