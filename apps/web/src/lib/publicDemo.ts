/** Public judge-demo flags — never enable signing from the browser. */

export const DEMO_PORTFOLIO_ID = "i-a-a4e7";

export function isPublicDemo(): boolean {
  return import.meta.env.VITE_PUBLIC_DEMO === "true";
}

/** Live OpenRouter dry-run only when BFF + trusted OCI + explicit flag. */
export function isPublicLiveAiEnabled(): boolean {
  return import.meta.env.VITE_PUBLIC_LIVE_AI === "true";
}

/** Demo / shared judge portfolios must never appear as a real user's custody. */
export function isDemoPortfolioId(id: string | null | undefined): boolean {
  if (!id) return false;
  const normalized = id.trim().toLowerCase();
  return (
    normalized === DEMO_PORTFOLIO_ID ||
    normalized.startsWith("nio-c-") ||
    normalized.startsWith("demo-")
  );
}
