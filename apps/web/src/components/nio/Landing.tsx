import { useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Fingerprint,
  KeyRound,
  Menu,
  Scale,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { NioLogo, Spark } from "./NioLogo";
import { LandingPreview } from "./LandingPreview";
import type { NavId } from "./nav";

const steps = [
  {
    name: "Authorize",
    title: "Ledger-backed owner mandate.",
    copy: "The owner sets policy on hardware. Trade limits, authorized assets, and pause/revoke stay under Ledger FullAccess — not a browser click.",
    icon: KeyRound,
    cta: "Open Security",
    nav: "security" as NavId,
    fields: ["Hardware FullAccess", "On-chain policy contract", "Pause / revoke"],
  },
  {
    name: "Analyze",
    title: "Researcher and Strategist.",
    copy: "OpenRouter agents read market context and propose a strategy. Models stay server-side. The browser never holds API keys.",
    icon: Sparkles,
    cta: "Open AI Agent",
    nav: "agent" as NavId,
    fields: ["Gemini 2.5 Flash", "Claude Sonnet 4.6", "Server-side OpenRouter"],
  },
  {
    name: "Challenge",
    title: "Fitter, Critic, and Policy Guard.",
    copy: "A deterministic Mandate Fitter adapts or rejects size. An independent Risk Critic can veto. NEAR policy remains the enforcement boundary.",
    icon: Scale,
    cta: "See live dry-run",
    nav: "agent" as NavId,
    fields: ["Deterministic Fitter", "GPT-5.2 Critic", "may_sign=false"],
  },
  {
    name: "Verify",
    title: "MPC, settlement, reconciliation.",
    copy: "When authorized, NEAR MPC signs, Sepolia settles, Tidepool confirms, and an independent reconciler checks the books. Dry-run never broadcasts.",
    icon: ShieldCheck,
    cta: "View evidence",
    nav: "activity" as NavId,
    fields: ["NEAR MPC", "Sepolia receipt", "Independent reconciler"],
  },
];

const faqs: [string, string][] = [
  [
    "What is NIO?",
    "NIO (near-intent-one) is an AI trading agent governed by hardware-authorized mandates. AI proposes; NEAR policy and MPC enforce; settlement is independently reconciled.",
  ],
  [
    "How does Ledger control mandates?",
    "Owner writes such as set_policy, pause, and revoke require Ledger FullAccess confirmation on-device. Browser wallets do not substitute for that hardware path.",
  ],
  [
    "Do judges need a wallet?",
    "No. You can explore the landing, overview, recorded Gate I/J/K evidence, and the public Live AI dry-run without connecting a wallet.",
  ],
  [
    "How do AI decisions work?",
    "Public Live AI calls POST /api/v1/gate-j/demo-decide. The server forces portfolio i-a-a4e7, dry_run=true, and may_sign=false. Researcher → Strategist → Fitter → Critic run on OpenRouter.",
  ],
  [
    "Why can a trade be blocked?",
    "Fitter rejection, Critic veto/abstain, NO_TRADE strategies, quota limits, or policy checks all produce honest BLOCKED / NO_TRADE outcomes with may_sign=false.",
  ],
  [
    "How does real execution differ from dry-run?",
    "Dry-run never requests MPC signing or Sepolia broadcast. Funded Gate K execution is recorded evidence only; public demo cannot invoke signing or acceptance override.",
  ],
  [
    "What does the Gate K operator override mean?",
    "The disclosed Gate K Sepolia trade ran after Fitter ECONOMIC_NOT_VIABLE and Critic REJECT, with a one-time operator acceptance override. It does not prove autonomous safety approval.",
  ],
];

export function Landing({ onOpen }: { onOpen: (id: NavId) => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [active, setActive] = useState(0);
  const step = steps[active];
  const Icon = step.icon;

  return (
    <div className="landing-page">
      <a className="landing-skip" href="#landing-main">
        Skip to content
      </a>
      <header className="landing-header">
        <button
          type="button"
          className="landing-wordmark-btn"
          aria-label="NIO home"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        >
          <NioLogo />
        </button>
        <nav
          className={menuOpen ? "landing-nav is-open" : "landing-nav"}
          aria-label="Landing navigation"
        >
          <a href="#how-it-works" onClick={() => setMenuOpen(false)}>
            How it works
          </a>
          <button type="button" className="landing-nav-link" onClick={() => onOpen("agent")}>
            Explore demo
          </button>
          <button type="button" className="landing-nav-link" onClick={() => onOpen("security")}>
            Security
          </button>
        </nav>
        <div className="landing-header-actions">
          <button
            type="button"
            className="landing-button small"
            onClick={() => onOpen("overview")}
          >
            Open workspace
            <ArrowUpRight size={18} />
          </button>
          <button
            type="button"
            className="landing-menu"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            {menuOpen ? <X /> : <Menu />}
          </button>
        </div>
      </header>
      <nav
        id="landing-mobile-nav"
        className="landing-mobile-nav"
        aria-label="Mobile landing navigation"
        hidden={!menuOpen}
      >
        <a href="#how-it-works" onClick={() => setMenuOpen(false)}>
          How it works
        </a>
        <button type="button" onClick={() => { setMenuOpen(false); onOpen("agent"); }}>
          Explore demo
        </button>
        <button type="button" onClick={() => { setMenuOpen(false); onOpen("security"); }}>
          Security
        </button>
      </nav>

      <main id="landing-main">
        <section className="landing-hero">
          <div className="landing-hero-copy">
            <div className="landing-hero-title landing-statement-title">
              <h1 aria-label="Hardware sets rules. AI makes decisions. NEAR enforces.">
                <span className="landing-reveal-line">
                  <span>Hardware sets rules.</span>
                </span>
                <span className="landing-reveal-line">
                  <span>AI makes decisions.</span>
                </span>
                <span className="landing-reveal-line landing-statement-accent">
                  <span>NEAR enforces.</span>
                </span>
              </h1>
              <div className="landing-built-signature">
                <p>Built for NEAR Hackathon 2026.</p>
                <p>NIO — near-intent-one · testnet only</p>
              </div>
            </div>
            <p>
              An AI trading agent governed by hardware-authorized mandates, with
              execution and settlement verifiable onchain.
            </p>
            <div className="landing-hero-actions">
              <button
                type="button"
                className="landing-button"
                onClick={() => onOpen("agent")}
              >
                Explore live demo
                <ArrowUpRight size={24} />
              </button>
              <a className="landing-hero-how" href="#how-it-works">
                See how it works
                <ArrowDown size={22} />
              </a>
            </div>
          </div>
          <div className="landing-hero-canvas">
            <Spark className="landing-hero-spark" />
            <div className="landing-canvas-orbit" aria-hidden="true" />
            <LandingPreview onOpenAgent={() => onOpen("agent")} />
            <div className="landing-query-sticker">
              <Sparkles size={24} />
              <strong>
                Live AI dry-run.
                <br />
                No signing.
              </strong>
            </div>
            <span className="landing-canvas-corner" aria-hidden="true">
              ↗
            </span>
          </div>
        </section>

        <div className="landing-signal-strip">
          <span>LEDGER AUTHORITY</span>
          <span aria-hidden="true">→</span>
          <span>OPENROUTER AI</span>
          <span aria-hidden="true">→</span>
          <span>NEAR MPC</span>
          <span aria-hidden="true">→</span>
          <span>VERIFIABLE EXECUTION</span>
        </div>

        <section id="how-it-works" className="landing-section landing-pipeline">
          <div className="landing-section-heading">
            <h2>
              Follow the mandate.
              <br />
              Find the decision.
            </h2>
            <p>
              Authorize on hardware, analyze with OpenRouter, challenge with
              Fitter and Critic, verify on NEAR — without inventing a trade.
            </p>
          </div>
          <div className="landing-step-tabs" role="tablist" aria-label="How NIO works">
            {steps.map((item, index) => (
              <button
                type="button"
                role="tab"
                key={item.name}
                id={`pipeline-tab-${index}`}
                aria-controls="pipeline-panel"
                aria-selected={active === index}
                tabIndex={active === index ? 0 : -1}
                onClick={() => setActive(index)}
              >
                <span>0{index + 1}</span>
                {item.name}
                <ArrowRight size={20} aria-hidden="true" />
              </button>
            ))}
          </div>
          <div
            className={`landing-step-panel step-${active}`}
            id="pipeline-panel"
            role="tabpanel"
            aria-labelledby={`pipeline-tab-${active}`}
          >
            <div className="landing-step-copy">
              <h3>{step.title}</h3>
              <p>{step.copy}</p>
              <button
                type="button"
                className="landing-text-link"
                onClick={() => onOpen(step.nav)}
              >
                {step.cta}
                <ArrowUpRight size={21} />
              </button>
            </div>
            <div className="landing-step-art">
              <div className="landing-step-symbol">
                <Icon size={72} strokeWidth={1.25} aria-hidden="true" />
              </div>
              <div className="landing-step-fields">
                {step.fields.map((field) => (
                  <div key={field}>
                    <Check size={20} aria-hidden="true" />
                    {field}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="landing-proof landing-section" id="proof">
          <div className="landing-proof-visual">
            <div className="landing-proof-paper">
              <div className="landing-proof-paper-header">
                <Fingerprint size={27} />
                <span>BUILT TO BE INSPECTED</span>
              </div>
              <div className="landing-proof-row">
                <span>Owner</span>
                <b>Ledger mandate</b>
              </div>
              <div className="landing-proof-row">
                <span>Policy</span>
                <b>NEAR policy contract</b>
              </div>
              <div className="landing-proof-row">
                <span>Challenge</span>
                <b>Fitter + Critic</b>
              </div>
              <div className="landing-proof-row">
                <span>Sign</span>
                <b>NEAR MPC</b>
              </div>
              <div className="landing-proof-row">
                <span>Settle</span>
                <b>Sepolia · Tidepool · Reconciler</b>
              </div>
              <div className="landing-proof-stamp">
                <Check size={23} />
                Follow every decision
                <br />
                back to its receipt.
              </div>
            </div>
            <Spark className="landing-proof-spark" />
          </div>
          <div className="landing-proof-copy">
            <h2>
              Real agents.
              <br />
              Even better
              <br />
              <span>receipts.</span>
            </h2>
            <p>
              Expand hashes for explorer links. Dry-run, fixture, and funded
              execution records stay clearly separated — including Gate K&apos;s
              disclosed one-time override.
            </p>
            <button
              type="button"
              className="landing-text-link"
              onClick={() => onOpen("activity")}
            >
              Look under the hood
              <ArrowUpRight size={22} />
            </button>
          </div>
        </section>

        <section className="landing-questions landing-section" id="questions">
          <div>
            <h2>
              A few things
              <br />
              worth knowing.
            </h2>
            <p>You can explore NIO before connecting a wallet.</p>
            <button
              type="button"
              className="landing-text-link"
              onClick={() => onOpen("overview")}
            >
              Take a look around
              <ArrowUpRight size={21} />
            </button>
          </div>
          <div className="landing-faq-list">
            {faqs.map(([question, answer]) => (
              <details key={question}>
                <summary>
                  {question}
                  <ChevronDown size={20} aria-hidden="true" />
                </summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="landing-final">
          <h2>
            Less guessing at agents.
            <br />
            More seeing <span>enforcement.</span>
          </h2>
          <div className="landing-final-actions">
            <button
              type="button"
              className="landing-button"
              onClick={() => onOpen("overview")}
            >
              Start exploring
              <ArrowUpRight size={23} />
            </button>
            <button
              type="button"
              className="landing-text-link"
              onClick={() => onOpen("agent")}
            >
              Run Live AI Analysis
              <ArrowRight size={22} />
            </button>
          </div>
          <Spark className="landing-final-spark" />
        </section>
      </main>

      <footer className="landing-footer">
        <div>
          <NioLogo />
          <p>NEAR Hackathon 2026 · testnet only</p>
        </div>
        <nav aria-label="Footer navigation">
          <button type="button" onClick={() => onOpen("overview")}>
            Overview
          </button>
          <button type="button" onClick={() => onOpen("agent")}>
            AI Agent
          </button>
          <button type="button" onClick={() => onOpen("activity")}>
            Evidence
          </button>
        </nav>
        <div className="landing-footer-note">
          MIT presentation styles adapted from AXIS.
          <br />
          Product logic remains NIO.
        </div>
      </footer>
    </div>
  );
}
