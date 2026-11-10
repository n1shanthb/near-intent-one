/** Public judge-demo flags — never enable signing from the browser. */

export function isPublicDemo(): boolean {
  return import.meta.env.VITE_PUBLIC_DEMO === "true";
}

/** Live OpenRouter dry-run only when BFF + trusted OCI + explicit flag. */
export function isPublicLiveAiEnabled(): boolean {
  return import.meta.env.VITE_PUBLIC_LIVE_AI === "true";
}
