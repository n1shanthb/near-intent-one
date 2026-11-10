/**
 * Same-origin BFF is the production default. Never require judges to set VITE_*.
 */
export function apiBase(): string {
  const raw = (import.meta.env.VITE_GATE_I_API_BASE as string | undefined)?.trim();
  if (raw) return raw.replace(/\/$/, "");
  return "/api/v1";
}

export function usesBff(): boolean {
  const root = apiBase();
  return root === "/api/v1" || root.endsWith("/api/v1");
}

export function publicApiLabel(): string {
  return usesBff() ? "Same-origin BFF · /api/v1" : `API · ${apiBase()}`;
}
