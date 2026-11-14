# NIO — Hackathon Submission Sheet

Use this with https://nearhackathon.com/#apply after the human confirms every field.

## Form fields

| Field | Value |
| --- | --- |
| Project name | NIO — NEAR Intent One |
| Team lead | Nishanth B |
| Contact email | *human provides* |
| Team size | `1` |
| Tracks | `defi`, `security`, `agents` |
| NEAR payout account | `nishanthb.near` |
| Repository | https://github.com/n1shanthb/near-intent-one |
| Demo post (X) | *PLACEHOLDER — human must publish with @NEARProtocol #NEARHackathon + demo* |
| Consent | Read verbatim to human before submit |

## 150-word description (form `idea` short cut)

NIO is a hardware-governed autonomous DeFi agent on NEAR. The owner sets a bounded mandate on `policy.nishanthb.near` with Ledger; the agent never receives FullAccess. OpenRouter models research and propose; a deterministic Fitter can reject trades; NEAR MPC Chain Signatures and NEAR Intents settle across Ethereum, Arbitrum, Base, and NEAR. Three owner-supervised mainnet Intents canaries are reconciled on-chain. Under an active autonomous mandate, the proven AI outcome is an auditable NO_TRADE receipt. A separate Agent Market hire escrowed 0.15 USDC for research. Judges inspect the live UI and explorers without keys.

## 300–500 word full description

**Problem.** Giving an AI agent trading authority usually means handing it keys or trusting an off-chain bot. That fails security review and cannot prove why a trade was refused.

**Product.** NIO binds agent behavior to a NEAR smart-contract mandate authorized by the owner’s Ledger. Caps (trade, daily, pending exposure), allowlisted chains/assets/destinations, slippage, and expiry live on `policy.nishanthb.near`. The contract owns the Chain Signatures derivation path; the agent proposes under FunctionCall scope only.

**How NEAR fits.** Chain Signatures produce EVM signatures without exporting owner keys. NEAR Intents / 1Click settle USDC across Ethereum, Arbitrum, Base, and NEAR. Audit WASM emits decision events so even a rejected plan is a NEAR receipt. Independent reconciliation closes pending exposure after settlement.

**Proven results.** Owner-supervised mainnet Intents settlements: J8B Arbitrum→Base, M1 Ethereum→NEAR (1 USDC), M2 Base→NEAR — each with EVM + NEAR reconcile links in `docs/PROOF_INDEX.md`. Autonomy WASM deployed and activated; judge renew holds epoch 4 (~10-day expiry). First autonomous on-chain decision: NO_TRADE / fitter REJECTED / NO_OPPORTUNITY (`CXR4ey…`). Agent Market: 0.15 USDC escrowed to `llmrt-onchain-research`, delivery pending. J18 shows authentic testnet MPC→Sepolia ERC20 (not Intents).

**Limits.** No claim of autonomous mainnet settled swap or 24/7 keeper uptime. Marketplace escrow ≠ delivery. Judges need no keys.

## Main innovation

Hardware-authorized on-chain mandate + deterministic fitter + MPC/Intents execution + auditable AI refusals on NEAR.

## NEAR technologies used

- NEAR smart contracts (policy + audit events)
- Chain Signatures (MPC)
- NEAR Intents / 1Click
- Named accounts (`nishanthb.near`, `policy.nishanthb.near`, `agent.nishanthb.near`)
- NEAR Agent Market (commerce)

## URLs

| | |
| --- | --- |
| Product | https://near-intent-one.vercel.app |
| Public GitHub | https://github.com/n1shanthb/near-intent-one |
| Contract | https://nearblocks.io/address/policy.nishanthb.near |
| Proof page | https://near-intent-one.vercel.app/verify |
| NO_TRADE receipt | https://nearblocks.io/txns/CXR4ey3x2x3scEhGeW8sRLnRAVsPrsYiRYFPcTAAAz1s |

## Key technical achievements

1. Contract-owned MPC path with pending-exposure revoke semantics  
2. Three supervised mainnet Intents settlements (Arb/Base/Eth/NEAR)  
3. Autonomous mandate + on-chain NO_TRADE audit receipt  
4. Real Agent Market escrow hire  
5. J18 authentic testnet MPC→Sepolia transfer  

## Exact limitations

- Autonomous settled mainnet swap: **not proven**  
- Keeper continuous uptime: **not claimed**  
- Agent Market deliverable: **pending** at submission  
- Demo X post / form submit: **manual human steps**  

## Team

Solo — Nishanth B. Also disclosing **Floorline** (separate project, Q-015).

## Placeholders (manual)

- Demo video / X post URL: ________________  
- Contact email: ________________  
- Submission API `requestId`: human generates UUID before POST  

**Do not POST the application until the human confirms the exact JSON payload.**
