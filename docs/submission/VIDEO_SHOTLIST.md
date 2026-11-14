# NIO Hackathon Video — Shotlist (137s)

| # | Time | Dur | Visual | Audio |
|---|---|---:|---|---|
| 1 | 00:00–00:08 | 8s | Hook card → Overview (epoch 4, Autonomous ON, $5/$25/$10) | Meet NIO… |
| 2 | 00:08–00:33 | 25s | **REAL Ledger clip** `video_20261115_002210_edit.mp4` (23.339s) + freeze pad · NIO side panel | Hardware mandate VO |
| 3 | 00:33–00:51 | 18s | Four-chain card → Mandate page (NEAR/Eth/Arb/Base) | Four-chain VO |
| 4 | 00:51–01:07 | 16s | Epoch-4 limits card → Mandate → Security | Fitter/contract VO |
| 5 | 01:07–01:30 | 23s | Settlements card → Arbiscan J8B → Etherscan M1 → Basescan M2 → Transactions | Supervised settlements VO |
| 6 | 01:30–01:51 | 21s | AI Agent → NO_TRADE card → Proof & Verify | Autonomous refusal VO |
| 7 | 01:51–02:04 | 13s | Agent hire card (0.15 USDC escrowed) → Overview | Agent Market VO |
| 8 | 02:04–02:17 | 13s | Inspect → Verify → End card | Closing VO |

## Sources

- Live UI: `private/video-work/captures/*.png` (Playwright 1920×1080)
- Ledger: `ultrademo-workspace/video_20261115_002210_edit.mp4` (1280×720 → letterboxed)
- Captions: `private/video-work/captions.srt`
- Assemble: `private/video-work/assemble-final.mjs`

## Honest labels

- J8B/M1/M2 = **owner-supervised** mainnet Intents settlements
- Autonomous proof = **NO_TRADE ONCHAIN_VERIFIED** (not a settled autonomous swap)
- Agent Market = **0.15 USDC escrowed** (DELIVERED only if verified)
