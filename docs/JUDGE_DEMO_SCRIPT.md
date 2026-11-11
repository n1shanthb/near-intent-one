# NIO — 2–3 minute judge demo script

**Product URL:** https://near-intent-one.vercel.app  
**Network:** NEAR testnet only  
**Honesty rule:** Do not claim physical Ledger owner login has passed unless hardware verification succeeded in that session.

---

## 0:00–0:20 · Landing (one CTA)

Open the landing page.

Say: “NIO is an AI trading agent where **Ledger sets the rules**, **AI proposes**, and **NEAR enforces**. Judges need no wallet.”

Click **Start 60-second demo** (or jump the walkthrough cards: Overview → AI Agent → Evidence → Security).

---

## 0:20–0:50 · Overview + roles

On Overview:

- Point to live status chips (API / Live AI).
- Say: “Three layers stay distinct: **recorded Gate K execution**, **live AI dry-run**, and **owner-only trading** which needs hardware later.”

Optional one-liner on roles:

- Ledger — hardware FullAccess for mandates  
- AI — OpenRouter Researcher / Strategist / Critic  
- NEAR — policy + MPC boundary  

---

## 0:50–1:30 · AI Agent (prefer fixtures)

Open **AI Agent**.

1. Show the **LIVE AI · DRY RUN** banner and whether the button is enabled.  
2. If Live AI is available and quota remains, you may run **one** Live AI Analysis — otherwise **do not burn OpenRouter budget**.  
3. Prefer **Fixture scenarios** A/B/C (deterministic, not LLM): show Fitter ALLOW / ADAPT / REJECT with `may_sign=false`.

Say: “Public demo never signs and never runs Gate K execute.”

---

## 1:30–2:10 · Evidence (real Gate K proof)

Open **Evidence**.

- Show the recorded Gate K Sepolia trade receipts / explorer links.  
- Disclose clearly: that trade used a **one-time operator acceptance override** after Fitter/Critic rejection — it is **not** proof of autonomous safe approval.  
- Point to independent reconciler / MPC narrative as recorded.

---

## 2:10–2:40 · Security + owner path (no hardware claim)

Open **Security**, then optionally **Owner auth**.

Say:

- “Signing is locked. Autonomous mode is off.”  
- “Owner auth is a real Ledger NEP-413 path with HttpOnly sessions, but **we are not claiming a hardware PASS in this video** without the device.”  
- “My Portfolio stays gated until ownership is verified; provisioning waits honestly.”

---

## 2:40–3:00 · Close

Return to landing or Evidence.

Close: “Judges can browse wallet-free, run dry-run AI when quotas allow, and inspect recorded on-chain proof — without mainnet, without signing, and without inventing a Ledger login.”

---

## Do not say

- That physical Ledger login already passed (unless it did).  
- That public Live AI can trade or sign.  
- That Gate K override equals normal AI approval.  
- That mainnet is enabled.
