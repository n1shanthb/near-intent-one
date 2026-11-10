/** Original NIO wordmark — AXIS geometry scale, not AXIS branding. */
export function NioLogo({ className = "landing-wordmark" }: { className?: string }) {
  return (
    <span className={className}>
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <rect x="3" y="3" width="26" height="26" rx="6" fill="currentColor" />
        <path
          d="M9 22V10h3.2l4.1 7.4V10H20v12h-3.1l-4.2-7.5V22H9Z"
          fill="#fff"
        />
      </svg>
      nio
      <span className="landing-logo-period">.</span>
    </span>
  );
}

export function NioBrandMark() {
  return (
    <svg className="axis-brand-symbol" viewBox="0 0 32 32" aria-hidden="true">
      <rect x="2" y="2" width="28" height="28" rx="7" fill="currentColor" />
      <path
        d="M9 22V10h3.2l4.1 7.4V10H20v12h-3.1l-4.2-7.5V22H9Z"
        fill="#fff"
      />
    </svg>
  );
}

export function Spark({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 100 100" aria-hidden="true">
      <path
        d="m50 0 7 31 25-21-15 29 33 3-31 12 25 22-32-9-5 33-11-31-24 24 12-31-34-5 32-10L9 21l30 13Z"
        fill="currentColor"
      />
    </svg>
  );
}
